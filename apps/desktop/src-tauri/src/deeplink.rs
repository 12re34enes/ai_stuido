//! `aistudio://` deep links: `aistudio://approval/<id>`, `aistudio://task/<id>`,
//! `aistudio://run/<id>` (and bare `aistudio://` / `aistudio://open` to just focus the app).

use serde::Serialize;
use tauri::AppHandle;
use url::Url;

use crate::events::{self, EVT_DEEP_LINK};

pub const SCHEME: &str = "aistudio";
const MAX_ID_LEN: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeepLinkKind {
    Approval,
    Task,
    Run,
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeepLink {
    pub url: String,
    pub kind: DeepLinkKind,
    pub id: Option<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

/// Parses and validates a deep link; `None` for anything we don't understand (ignored).
pub fn parse_deep_link(raw: &str) -> Option<DeepLink> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != SCHEME {
        return None;
    }
    // `aistudio://approval/x` → host "approval", path "/x";
    // `aistudio:approval/x` (no authority) → path "approval/x".
    let mut segments: Vec<String> = Vec::new();
    if let Some(host) = url.host_str().filter(|h| !h.is_empty()) {
        segments.push(host.to_ascii_lowercase());
    }
    segments.extend(
        url.path()
            .split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    );
    let (kind, id) = match segments.as_slice() {
        [] => (DeepLinkKind::Open, None),
        [only] if only.eq_ignore_ascii_case("open") => (DeepLinkKind::Open, None),
        [kind, id] => {
            let kind = match kind.to_ascii_lowercase().as_str() {
                "approval" => DeepLinkKind::Approval,
                "task" => DeepLinkKind::Task,
                "run" => DeepLinkKind::Run,
                _ => return None,
            };
            if !valid_id(id) {
                return None;
            }
            (kind, Some(id.clone()))
        }
        _ => return None,
    };
    Some(DeepLink {
        url: url.to_string(),
        kind,
        id,
    })
}

/// Focuses the main window and forwards the link (queued if the page isn't listening yet).
pub fn handle_url(app: &AppHandle, raw: &str) {
    match parse_deep_link(raw) {
        Some(link) => {
            log::info!("deep link: {:?} {:?}", link.kind, link.id);
            crate::windows::show_main(app);
            if link.kind != DeepLinkKind::Open {
                events::emit_main(app, EVT_DEEP_LINK, link);
            }
        }
        None => log::warn!("ignoring unsupported deep link"),
    }
}

/// Wires the deep-link plugin (URLs while running + the URL that launched the app).
pub fn init(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle_url(&handle, url.as_str());
        }
    });
    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                handle_url(app, url.as_str());
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!("deep link get_current failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_links() {
        let l = parse_deep_link("aistudio://approval/apr_01JABC").expect("approval");
        assert_eq!(l.kind, DeepLinkKind::Approval);
        assert_eq!(l.id.as_deref(), Some("apr_01JABC"));

        let l = parse_deep_link("aistudio://task/tsk_1/").expect("task");
        assert_eq!(l.kind, DeepLinkKind::Task);
        assert_eq!(l.id.as_deref(), Some("tsk_1"));

        let l = parse_deep_link("AISTUDIO://RUN/run-9?from=notification").expect("run");
        assert_eq!(l.kind, DeepLinkKind::Run);
        assert_eq!(l.id.as_deref(), Some("run-9"));

        let l = parse_deep_link("aistudio:approval/apr_2").expect("no authority");
        assert_eq!(l.kind, DeepLinkKind::Approval);
    }

    #[test]
    fn parses_open_links() {
        assert_eq!(
            parse_deep_link("aistudio://").map(|l| l.kind),
            Some(DeepLinkKind::Open)
        );
        assert_eq!(
            parse_deep_link("aistudio://open").map(|l| l.kind),
            Some(DeepLinkKind::Open)
        );
    }

    #[test]
    fn rejects_unsupported_links() {
        for bad in [
            "",
            "not a url",
            "https://approval/apr_1",
            "aistudio://approval",
            "aistudio://approval/",
            "aistudio://unknown/x",
            "aistudio://approval/a/b",
            "aistudio://approval/%3Cscript%3E",
            "aistudio://task/has space",
        ] {
            assert_eq!(parse_deep_link(bad), None, "{bad}");
        }
        let long = format!("aistudio://task/{}", "a".repeat(200));
        assert_eq!(parse_deep_link(&long), None);
    }

    #[test]
    fn serializes_for_the_webview() {
        let l = parse_deep_link("aistudio://approval/apr_1").expect("approval");
        let v = serde_json::to_value(&l).expect("json");
        assert_eq!(v["kind"], "approval");
        assert_eq!(v["id"], "apr_1");
        assert_eq!(v["url"], "aistudio://approval/apr_1");
    }
}
