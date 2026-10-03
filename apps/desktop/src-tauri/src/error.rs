//! Shell error type. `Display` is the Turkish, user-facing message; `code` is stable and
//! machine-readable. Commands reject with `{ code, message }` so the UI can show `message`
//! directly and branch on `code`.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("Motor (studiod) başlatılamadı: {0}")]
    BackendStart(String),

    #[error("Motor (studiod) {seconds} saniye içinde yanıt vermedi. Günlükler: {log_hint}")]
    BackendTimeout { seconds: u64, log_hint: String },

    #[error("Gömülü Python bulunamadı ({0}). Uygulamayı scripts/package/build-macos-app.sh ile paketleyin ya da AISTUDIO_PYTHON değişkenini ayarlayın.")]
    BundledPythonMissing(String),

    #[error(
        "Geliştirme modunda motor `make dev` tarafından yönetilir; buradan yeniden başlatılamaz."
    )]
    DevModeManaged,

    #[error("Anahtar Zinciri'nde API belirteci bulunamadı (servis \"AI Studio\", hesap \"studiod/api-token\"). Motor ilk açılışta oluşturur; birkaç saniye sonra tekrar deneyin.")]
    TokenMissing,

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    #[error("Anahtar Zinciri erişimi reddedildi. AI Studio'nun \"AI Studio\" anahtarına erişmesine izin verin.")]
    KeychainDenied,

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    #[error("Anahtar Zinciri okunamadı: {0}")]
    Keychain(String),

    #[error("Geçersiz kısayol \"{accelerator}\": {reason}")]
    InvalidShortcut { accelerator: String, reason: String },

    #[error("Kısayol \"{0}\" kaydedilemedi; başka bir uygulama kullanıyor olabilir.")]
    ShortcutUnavailable(String),

    #[error("Geçersiz bağlantı: {0}")]
    InvalidUrl(String),

    #[error("Geçersiz yol: {0}")]
    InvalidPath(String),

    #[error("Desteklenen bir editör bulunamadı (Visual Studio Code, Cursor, Zed, Xcode).")]
    NoEditor,

    #[error("Geçersiz istek: {0}")]
    InvalidInput(String),

    #[cfg_attr(target_os = "macos", allow(dead_code))]
    #[error("Bu işlem yalnız macOS'ta desteklenir.")]
    Unsupported,

    #[error("Pencere işlemi başarısız: {0}")]
    Window(String),

    #[error("Ayarlar kaydedilemedi: {0}")]
    Settings(String),

    #[error("Komut çalıştırılamadı: {0}")]
    Process(String),
}

impl ShellError {
    pub fn code(&self) -> &'static str {
        match self {
            ShellError::BackendStart(_) => "backend_start_failed",
            ShellError::BackendTimeout { .. } => "backend_timeout",
            ShellError::BundledPythonMissing(_) => "bundled_python_missing",
            ShellError::DevModeManaged => "dev_mode_managed",
            ShellError::TokenMissing => "token_missing",
            ShellError::KeychainDenied => "keychain_denied",
            ShellError::Keychain(_) => "keychain_error",
            ShellError::InvalidShortcut { .. } => "invalid_shortcut",
            ShellError::ShortcutUnavailable(_) => "shortcut_unavailable",
            ShellError::InvalidUrl(_) => "invalid_url",
            ShellError::InvalidPath(_) => "invalid_path",
            ShellError::NoEditor => "no_editor",
            ShellError::InvalidInput(_) => "invalid_input",
            ShellError::Unsupported => "unsupported",
            ShellError::Window(_) => "window_error",
            ShellError::Settings(_) => "settings_error",
            ShellError::Process(_) => "process_error",
        }
    }
}

impl From<tauri::Error> for ShellError {
    fn from(e: tauri::Error) -> Self {
        ShellError::Window(e.to_string())
    }
}

impl Serialize for ShellError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("ShellError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type ShellResult<T> = Result<T, ShellError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_turkish_message() {
        let err = ShellError::ShortcutUnavailable("Control+Alt+Space".into());
        let v = serde_json::to_value(&err).expect("serialize");
        assert_eq!(v["code"], "shortcut_unavailable");
        assert!(v["message"]
            .as_str()
            .is_some_and(|m| m.contains("kaydedilemedi")));
    }
}
