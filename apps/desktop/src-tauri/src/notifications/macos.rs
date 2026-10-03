//! `UNUserNotificationCenter` integration (macOS 10.14+; we target 13+).

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_foundation::{
    NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSSet, NSString,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

use super::{
    action_name, all_action_sets, category_id, dispatch_action, fallback_notify,
    NotificationAction, NotificationActionEvent, NotifyRequest, NotifyResult,
};

const STATE_UNKNOWN: u8 = 0;
const STATE_GRANTED: u8 = 1;
const STATE_DENIED: u8 = 2;
/// Not inside a signed .app bundle, or the system refused us: use the osascript fallback.
const STATE_UNAVAILABLE: u8 = 3;

static STATE: AtomicU8 = AtomicU8::new(STATE_UNKNOWN);

const KEY_ID: &str = "id";
const KEY_APPROVAL_ID: &str = "approval_id";
const KEY_DEEP_LINK: &str = "deep_link";

pub struct DelegateIvars {
    app: AppHandle,
}

define_class!(
    // SAFETY:
    // - NSObject has no subclassing requirements.
    // - NotificationDelegate does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "AIStudioNotificationDelegate"]
    #[ivars = DelegateIvars]
    pub struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        /// Show banners even while AI Studio is the frontmost app.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            if let Some(event) = response_to_event(response) {
                dispatch_action(&self.ivars().app, event);
            }
            completion_handler.call(());
        }
    }
);

impl NotificationDelegate {
    fn new(app: AppHandle) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { app });
        // SAFETY: NSObject's designated initialiser, called once on a freshly allocated object.
        unsafe { msg_send![super(this), init] }
    }
}

fn string_for(dict: &NSDictionary, key: &str) -> Option<String> {
    let key = NSString::from_str(key);
    let value: Retained<AnyObject> = dict.objectForKey(&key)?;
    value.downcast_ref::<NSString>().map(|s| s.to_string())
}

fn response_to_event(response: &UNNotificationResponse) -> Option<NotificationActionEvent> {
    let identifier = response.actionIdentifier().to_string();
    // Dismissals (and unknown identifiers) are not forwarded.
    let action = action_name(&identifier)?;
    let request = response.notification().request();
    let info = request.content().userInfo();
    Some(NotificationActionEvent {
        id: string_for(&info, KEY_ID).unwrap_or_else(|| request.identifier().to_string()),
        action: action.to_owned(),
        approval_id: string_for(&info, KEY_APPROVAL_ID),
        deep_link: string_for(&info, KEY_DEEP_LINK),
    })
}

/// UNUserNotificationCenter raises (and aborts the process) when the executable is not inside
/// an app bundle, e.g. under `tauri dev`. Only touch it from a real `.app`.
fn running_from_app_bundle() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundlePath().to_string().ends_with(".app") && bundle.bundleIdentifier().is_some()
}

fn categories() -> Retained<NSSet<UNNotificationCategory>> {
    let categories: Vec<Retained<UNNotificationCategory>> = all_action_sets()
        .iter()
        .filter_map(|set| {
            let id = category_id(set)?;
            let actions: Vec<Retained<UNNotificationAction>> = set
                .iter()
                .map(|action| {
                    let options = match action {
                        NotificationAction::Approve => UNNotificationActionOptions::empty(),
                        NotificationAction::Reject => UNNotificationActionOptions::Destructive,
                        NotificationAction::Open => UNNotificationActionOptions::Foreground,
                    };
                    UNNotificationAction::actionWithIdentifier_title_options(
                        &NSString::from_str(action.identifier()),
                        &NSString::from_str(action.title()),
                        options,
                    )
                })
                .collect();
            let actions = NSArray::from_retained_slice(&actions);
            let intents: Retained<NSArray<NSString>> = NSArray::new();
            Some(
                UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                    &NSString::from_str(&id),
                    &actions,
                    &intents,
                    UNNotificationCategoryOptions::empty(),
                ),
            )
        })
        .collect();
    NSSet::from_retained_slice(&categories)
}

fn request_authorization(center: &UNUserNotificationCenter) {
    let block = RcBlock::new(|granted: Bool, error: *mut NSError| {
        // SAFETY: the system passes either null or a valid NSError for the block's duration.
        if let Some(error) = unsafe { error.as_ref() } {
            log::warn!(
                "notification authorization failed, using fallback: {}",
                error.localizedDescription()
            );
            STATE.store(STATE_UNAVAILABLE, Ordering::SeqCst);
        } else if granted.as_bool() {
            STATE.store(STATE_GRANTED, Ordering::SeqCst);
        } else {
            log::info!("notifications denied by the user");
            STATE.store(STATE_DENIED, Ordering::SeqCst);
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge,
        &block,
    );
}

pub fn init(app: &AppHandle) {
    if !running_from_app_bundle() {
        log::info!("not running from an .app bundle; notifications use the osascript fallback");
        STATE.store(STATE_UNAVAILABLE, Ordering::SeqCst);
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate = NotificationDelegate::new(app.clone());
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // `delegate` is a weak property on the center: keep ours alive for the process lifetime.
    std::mem::forget(delegate);
    center.setNotificationCategories(&categories());
    request_authorization(&center);
}

pub fn permission(_app: &AppHandle) -> &'static str {
    match STATE.load(Ordering::SeqCst) {
        STATE_GRANTED => "granted",
        STATE_DENIED => "denied",
        STATE_UNAVAILABLE => "fallback",
        _ => "not-determined",
    }
}

fn user_info(req: &NotifyRequest) -> Retained<NSDictionary<AnyObject, AnyObject>> {
    let mut pairs: Vec<(&str, &str)> = vec![(KEY_ID, req.id.as_str())];
    if let Some(a) = &req.approval_id {
        pairs.push((KEY_APPROVAL_ID, a.as_str()));
    }
    if let Some(l) = &req.deep_link {
        pairs.push((KEY_DEEP_LINK, l.as_str()));
    }
    let keys: Vec<Retained<NSString>> = pairs.iter().map(|(k, _)| NSString::from_str(k)).collect();
    let values: Vec<Retained<NSString>> =
        pairs.iter().map(|(_, v)| NSString::from_str(v)).collect();
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let value_refs: Vec<&NSString> = values.iter().map(|v| &**v).collect();
    let dict: Retained<NSDictionary<NSString, NSString>> =
        NSDictionary::from_slices(&key_refs, &value_refs);
    // SAFETY: NSString keys/values are AnyObjects; widening the generic parameters is sound.
    unsafe { Retained::cast_unchecked::<NSDictionary<AnyObject, AnyObject>>(dict) }
}

fn add_request(req: &NotifyRequest) -> Result<(), String> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&req.title));
    content.setBody(&NSString::from_str(&req.body));
    if req.sound {
        content.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    if let Some(category) = category_id(&req.actions) {
        content.setCategoryIdentifier(&NSString::from_str(&category));
    }
    let thread = if req.approval_id.is_some() {
        "aistudio.approvals"
    } else {
        "aistudio.alerts"
    };
    content.setThreadIdentifier(&NSString::from_str(thread));
    let info = user_info(req);
    // SAFETY: the dictionary only holds NSString keys and values (property-list types).
    unsafe { content.setUserInfo(&info) };

    // Same identifier replaces an earlier notification for the same alert.
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&req.id),
        &content,
        None,
    );
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let block = RcBlock::new(move |error: *mut NSError| {
        // SAFETY: null or a valid NSError for the block's duration.
        let result = match unsafe { error.as_ref() } {
            Some(error) => Err(error.localizedDescription().to_string()),
            None => Ok(()),
        };
        let _ = tx.send(result);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&block));
    rx.recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|_| Err("bildirim merkezi yanıt vermedi".into()))
}

pub fn notify(_app: &AppHandle, req: &NotifyRequest) -> NotifyResult {
    match STATE.load(Ordering::SeqCst) {
        STATE_UNAVAILABLE => fallback_notify(req),
        STATE_DENIED => NotifyResult {
            delivered: false,
            backend: "usernotifications",
            reason: Some(
                "macOS bildirim izni kapalı. Sistem Ayarları › Bildirimler › AI Studio'dan açabilirsiniz."
                    .into(),
            ),
        },
        _ => match add_request(req) {
            Ok(()) => NotifyResult {
                delivered: true,
                backend: "usernotifications",
                reason: None,
            },
            Err(e) => {
                log::warn!("UNUserNotificationCenter refused notification: {e}");
                let mut result = fallback_notify(req);
                if result.reason.is_none() {
                    result.reason = Some(format!("Bildirim merkezi reddetti: {e}"));
                }
                result
            }
        },
    }
}
