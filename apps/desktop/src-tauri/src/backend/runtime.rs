//! `runtime.json` (written by `studiod serve`) and the local URL scheme.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Contents of `<data dir>/runtime.json`: `{"port": int, "pid": int, "version": str, "started_at": str}`.
/// The API token is deliberately NOT in this file (it lives in the Keychain).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RuntimeInfo {
    pub port: u16,
    pub pid: u32,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
}

pub fn parse_runtime(text: &str) -> Result<RuntimeInfo, String> {
    let info: RuntimeInfo =
        serde_json::from_str(text).map_err(|e| format!("runtime.json okunamadı: {e}"))?;
    if info.port == 0 {
        return Err("runtime.json geçersiz port içeriyor".into());
    }
    Ok(info)
}

/// Reads and parses runtime.json; `None` when missing or malformed (studiod not running yet,
/// or mid-write).
pub fn read_runtime(path: &Path) -> Option<RuntimeInfo> {
    let text = std::fs::read_to_string(path).ok()?;
    parse_runtime(&text).ok()
}

pub fn runtime_file(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime.json")
}

/// studiod only ever listens on loopback.
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Mirrors `aistudio.core.config.default_home()` for the production layout (no
/// `AISTUDIO_HOME` override: the LaunchAgent never sets it).
pub fn default_data_dir(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("AI Studio")
    } else {
        match std::env::var_os("XDG_DATA_HOME") {
            Some(xdg) if !xdg.is_empty() => PathBuf::from(xdg).join("aistudio"),
            _ => home.join(".local").join("share").join("aistudio"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_runtime_file() {
        let info = parse_runtime(
            r#"{"port": 51234, "pid": 4242, "version": "0.1.0", "started_at": "2026-10-03T08:00:00+00:00"}"#,
        )
        .expect("valid");
        assert_eq!(info.port, 51234);
        assert_eq!(info.pid, 4242);
        assert_eq!(info.version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn parses_minimal_runtime_file() {
        let info = parse_runtime(r#"{"port": 8765, "pid": 1}"#).expect("valid");
        assert_eq!(info.version, None);
    }

    #[test]
    fn rejects_bad_runtime_files() {
        assert!(parse_runtime("").is_err());
        assert!(parse_runtime(r#"{"running": false}"#).is_err());
        assert!(parse_runtime(r#"{"port": 0, "pid": 1}"#).is_err());
        assert!(parse_runtime(r#"{"port": 70000, "pid": 1}"#).is_err());
        assert!(parse_runtime(r#"{"port": "8765", "pid": 1}"#).is_err());
    }

    #[test]
    fn reads_runtime_from_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = runtime_file(dir.path());
        assert_eq!(read_runtime(&path), None);
        std::fs::write(&path, r#"{"port": 9000, "pid": 7}"#).expect("write");
        assert_eq!(read_runtime(&path).map(|r| r.port), Some(9000));
        std::fs::write(&path, "{\"port\": 90").expect("write");
        assert_eq!(read_runtime(&path), None);
    }

    #[test]
    fn builds_loopback_urls() {
        assert_eq!(base_url(8765), "http://127.0.0.1:8765");
    }

    #[test]
    fn default_data_dir_matches_backend_layout() {
        let dir = default_data_dir(Path::new("/Users/someone"));
        if cfg!(target_os = "macos") {
            assert_eq!(
                dir,
                PathBuf::from("/Users/someone/Library/Application Support/AI Studio")
            );
        } else {
            assert!(dir.ends_with("aistudio"));
        }
    }
}
