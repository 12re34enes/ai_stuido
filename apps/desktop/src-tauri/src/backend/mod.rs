//! studiod lifecycle as seen from the shell: where it listens, how to authenticate, and how to
//! get it running under launchd when it isn't.
//!
//! - **dev** (`AISTUDIO_DEV=1`, or a debug build with `AISTUDIO_PORT` set — `make dev-app`):
//!   `http://127.0.0.1:<AISTUDIO_PORT>`, token = `AISTUDIO_DEV_TOKEN`. studiod is managed by make.
//! - **production**: `~/Library/Application Support/AI Studio/runtime.json` → port, verified via
//!   `GET /health`; token from the Keychain. If studiod is down, the LaunchAgent is (re)installed
//!   with the bundled Python and the shell waits for it.

pub mod health;
pub mod keychain;
pub mod launchd;
pub mod runtime;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{ShellError, ShellResult};
use runtime::{base_url, read_runtime, runtime_file, RuntimeInfo};

pub const DEFAULT_DEV_PORT: u16 = 8765;
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const START_TIMEOUT: Duration = Duration::from_secs(25);
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const RESTART_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// What `backend_info` returns to the webview (contract shared with `src/lib/backend.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendInfo {
    pub url: String,
    pub token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    /// "dev" | "production"
    pub mode: &'static str,
    pub url: Option<String>,
    pub running: bool,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub version: Option<String>,
    /// production only: whether `~/Library/LaunchAgents/app.aistudio.studiod.plist` exists.
    pub agent_installed: Option<bool>,
    pub data_dir: Option<String>,
    pub log_file: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevConfig {
    /// `None` → resolve from `$AISTUDIO_HOME/runtime.json`, else 8765.
    pub port: Option<u16>,
    pub token: Option<String>,
    pub home: Option<PathBuf>,
}

impl DevConfig {
    pub fn resolve_port(&self) -> u16 {
        self.port
            .or_else(|| {
                self.home
                    .as_deref()
                    .and_then(|h| read_runtime(&runtime_file(h)))
                    .map(|r| r.port)
            })
            .unwrap_or(DEFAULT_DEV_PORT)
    }
}

/// Dev mode when `AISTUDIO_DEV=1`, or in debug builds when `AISTUDIO_PORT` is set.
pub fn detect_dev(get: impl Fn(&str) -> Option<String>, debug_build: bool) -> Option<DevConfig> {
    let port_var = get("AISTUDIO_PORT").filter(|p| !p.trim().is_empty());
    let dev_flag = get("AISTUDIO_DEV").as_deref() == Some("1");
    if !(dev_flag || (debug_build && port_var.is_some())) {
        return None;
    }
    Some(DevConfig {
        port: port_var
            .and_then(|p| p.trim().parse::<u16>().ok())
            .filter(|p| *p != 0),
        token: get("AISTUDIO_DEV_TOKEN").filter(|t| !t.is_empty()),
        home: get("AISTUDIO_HOME")
            .filter(|h| !h.is_empty())
            .map(PathBuf::from),
    })
}

/// `<Resources>/backend/python/bin/python3` (python-build-standalone `install_only` layout).
pub fn bundled_python(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join("backend")
        .join("python")
        .join("bin")
        .join("python3")
}

type TokenReader = Box<dyn Fn() -> ShellResult<String> + Send + Sync>;

pub struct BackendManager {
    dev: Option<DevConfig>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    home: PathBuf,
    data_dir: PathBuf,
    python: Option<PathBuf>,
    read_token: TokenReader,
    /// Serialises start/restart so three windows asking at once don't race launchctl.
    lifecycle: Mutex<()>,
    /// Cached Keychain token: each Keychain read may prompt the user.
    token: Mutex<Option<String>>,
}

impl BackendManager {
    pub fn new(
        dev: Option<DevConfig>,
        home: PathBuf,
        data_dir: PathBuf,
        python: Option<PathBuf>,
        read_token: TokenReader,
    ) -> Self {
        Self {
            dev,
            home,
            data_dir,
            python,
            read_token,
            lifecycle: Mutex::new(()),
            token: Mutex::new(None),
        }
    }

    /// Production wiring: environment, `$HOME`, the app's resource dir and the Keychain.
    pub fn from_env(resource_dir: Option<PathBuf>, home: PathBuf) -> Self {
        let dev = detect_dev(|k| std::env::var(k).ok(), cfg!(debug_assertions));
        let python = std::env::var_os("AISTUDIO_PYTHON")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .or_else(|| resource_dir.as_deref().map(bundled_python));
        let data_dir = runtime::default_data_dir(&home);
        Self::new(dev, home, data_dir, python, Box::new(keychain::read_token))
    }

    pub fn is_dev(&self) -> bool {
        self.dev.is_some()
    }

    pub fn log_file(&self) -> PathBuf {
        self.data_dir.join("logs").join("studiod.err.log")
    }

    /// `{ url, token }` for the webview; in production this starts studiod if needed (blocking,
    /// call from a worker thread).
    pub fn info(&self) -> ShellResult<BackendInfo> {
        if let Some(dev) = &self.dev {
            return Ok(BackendInfo {
                url: base_url(dev.resolve_port()),
                token: dev.token.clone(),
            });
        }
        let rt = self.ensure_running()?;
        Ok(BackendInfo {
            url: base_url(rt.port),
            token: Some(self.token()?),
        })
    }

    /// Cheap, side-effect free snapshot (never starts anything).
    pub fn status(&self) -> BackendStatus {
        if let Some(dev) = &self.dev {
            let port = dev.resolve_port();
            let health = health::check_health(port, HEALTH_TIMEOUT);
            return BackendStatus {
                mode: "dev",
                url: Some(base_url(port)),
                running: health.is_ok(),
                pid: None,
                port: Some(port),
                version: health.as_ref().ok().and_then(|h| h.version.clone()),
                agent_installed: None,
                data_dir: dev.home.as_ref().map(|h| h.display().to_string()),
                log_file: None,
                error: health.err(),
            };
        }
        let rt = read_runtime(&runtime_file(&self.data_dir));
        let health = rt
            .as_ref()
            .map(|r| health::check_health(r.port, HEALTH_TIMEOUT));
        let running = matches!(health, Some(Ok(_)));
        BackendStatus {
            mode: "production",
            url: rt.as_ref().filter(|_| running).map(|r| base_url(r.port)),
            running,
            pid: rt.as_ref().map(|r| r.pid),
            port: rt.as_ref().map(|r| r.port),
            version: match &health {
                Some(Ok(h)) => h.version.clone(),
                _ => rt.as_ref().and_then(|r| r.version.clone()),
            },
            agent_installed: Some(self.agent_installed()),
            data_dir: Some(self.data_dir.display().to_string()),
            log_file: Some(self.log_file().display().to_string()),
            error: match health {
                Some(Err(e)) => Some(e),
                Some(Ok(_)) => None,
                None => Some("runtime.json bulunamadı".into()),
            },
        }
    }

    /// Restarts studiod through launchd and waits for the new instance.
    pub fn restart(&self) -> ShellResult<BackendInfo> {
        if self.dev.is_some() {
            return Err(ShellError::DevModeManaged);
        }
        {
            let _guard = self
                .lifecycle
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *self.token.lock().unwrap_or_else(PoisonError::into_inner) = None;
            let previous = read_runtime(&runtime_file(&self.data_dir)).map(|r| r.pid);
            self.restart_locked(previous)?;
        }
        self.info()
    }

    #[cfg(target_os = "macos")]
    fn restart_locked(&self, previous: Option<u32>) -> ShellResult<RuntimeInfo> {
        if launchd::is_loaded() {
            launchd::kickstart(true)?;
            self.wait_healthy(RESTART_TIMEOUT, previous)
        } else {
            self.start_and_wait(previous)
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn restart_locked(&self, _previous: Option<u32>) -> ShellResult<RuntimeInfo> {
        Err(ShellError::Unsupported)
    }

    fn agent_installed(&self) -> bool {
        launchd::plist_path(&self.home).exists()
    }

    fn healthy_runtime(&self) -> Option<RuntimeInfo> {
        let rt = read_runtime(&runtime_file(&self.data_dir))?;
        health::check_health(rt.port, HEALTH_TIMEOUT).ok()?;
        Some(rt)
    }

    fn ensure_running(&self) -> ShellResult<RuntimeInfo> {
        if let Some(rt) = self.healthy_runtime() {
            return Ok(rt);
        }
        let _guard = self
            .lifecycle
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Another caller may have started it while we waited for the lock.
        if let Some(rt) = self.healthy_runtime() {
            return Ok(rt);
        }
        self.start_and_wait(None)
    }

    #[cfg(target_os = "macos")]
    fn start_and_wait(&self, previous: Option<u32>) -> ShellResult<RuntimeInfo> {
        let python = self.python()?;
        let plist = std::fs::read_to_string(launchd::plist_path(&self.home)).ok();
        let current = plist
            .as_deref()
            .is_some_and(|p| launchd::plist_uses_python(p, &python));
        let mut installed = false;
        if current && launchd::is_loaded() {
            log::info!("studiod not healthy; kickstarting LaunchAgent");
            if let Err(e) = launchd::kickstart(false) {
                log::warn!("kickstart failed: {e}");
            }
        } else {
            log::info!("installing LaunchAgent with {}", python.display());
            launchd::install_agent(&python)?;
            installed = true;
        }
        match self.wait_healthy(START_TIMEOUT, previous) {
            Ok(rt) => Ok(rt),
            Err(e) if !installed => {
                log::warn!("studiod did not come up after kickstart ({e}); reinstalling agent");
                launchd::install_agent(&python)?;
                self.wait_healthy(START_TIMEOUT, previous)
            }
            Err(e) => Err(e),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn start_and_wait(&self, _previous: Option<u32>) -> ShellResult<RuntimeInfo> {
        Err(ShellError::BackendStart(format!(
            "çalışan bir studiod bulunamadı ({}); bu platformda otomatik başlatma yok, `studiod serve` ile elle başlatın",
            runtime_file(&self.data_dir).display()
        )))
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn python(&self) -> ShellResult<PathBuf> {
        match &self.python {
            Some(p) if p.exists() => Ok(p.clone()),
            Some(p) => Err(ShellError::BundledPythonMissing(p.display().to_string())),
            None => Err(ShellError::BundledPythonMissing("kaynak dizini yok".into())),
        }
    }

    /// Polls runtime.json + /health until a healthy instance (other than `previous` pid) answers.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn wait_healthy(&self, timeout: Duration, previous: Option<u32>) -> ShellResult<RuntimeInfo> {
        let deadline = Instant::now() + timeout;
        let path = runtime_file(&self.data_dir);
        loop {
            if let Some(rt) = read_runtime(&path) {
                if Some(rt.pid) != previous && health::check_health(rt.port, HEALTH_TIMEOUT).is_ok()
                {
                    return Ok(rt);
                }
            }
            if Instant::now() >= deadline {
                return Err(ShellError::BackendTimeout {
                    seconds: timeout.as_secs(),
                    log_hint: self.log_file().display().to_string(),
                });
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn token(&self) -> ShellResult<String> {
        let mut cached = self.token.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(token) = cached.as_ref() {
            return Ok(token.clone());
        }
        // studiod writes the token before runtime.json, but tolerate a short race on first run.
        let mut attempt = 0;
        let token = loop {
            match (self.read_token)() {
                Err(ShellError::TokenMissing) if attempt < 4 => {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(500));
                }
                other => break other?,
            }
        };
        *cached = Some(token.clone());
        Ok(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn test_token() -> String {
        // Built at runtime: never commit realistic secret literals.
        ["unit", "test", "token"].join("-")
    }

    #[test]
    fn production_by_default() {
        assert_eq!(detect_dev(env(&[]), false), None);
        assert_eq!(detect_dev(env(&[]), true), None);
        // A port alone does not switch release builds to dev.
        assert_eq!(detect_dev(env(&[("AISTUDIO_PORT", "8765")]), false), None);
    }

    #[test]
    fn dev_flag_enables_dev_mode() {
        let dev = detect_dev(
            env(&[
                ("AISTUDIO_DEV", "1"),
                ("AISTUDIO_PORT", "9001"),
                ("AISTUDIO_DEV_TOKEN", "dev-token"),
            ]),
            false,
        )
        .expect("dev");
        assert_eq!(dev.port, Some(9001));
        assert_eq!(dev.token.as_deref(), Some("dev-token"));
        assert_eq!(dev.resolve_port(), 9001);
    }

    #[test]
    fn debug_build_with_port_is_dev() {
        let dev = detect_dev(env(&[("AISTUDIO_PORT", "8765")]), true).expect("dev");
        assert_eq!(dev.token, None);
        assert_eq!(dev.resolve_port(), 8765);
    }

    #[test]
    fn dev_port_zero_resolves_from_runtime_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(runtime_file(dir.path()), r#"{"port": 40123, "pid": 99}"#).expect("write");
        let home = dir.path().to_string_lossy().into_owned();
        let dev = detect_dev(
            env(&[
                ("AISTUDIO_DEV", "1"),
                ("AISTUDIO_PORT", "0"),
                ("AISTUDIO_HOME", &home),
            ]),
            false,
        )
        .expect("dev");
        assert_eq!(dev.port, None);
        assert_eq!(dev.resolve_port(), 40123);
        let no_home = DevConfig {
            port: None,
            token: None,
            home: None,
        };
        assert_eq!(no_home.resolve_port(), DEFAULT_DEV_PORT);
    }

    #[test]
    fn dev_info_uses_env_values() {
        let mgr = BackendManager::new(
            Some(DevConfig {
                port: Some(8765),
                token: Some("dev-token".into()),
                home: None,
            }),
            PathBuf::from("/nonexistent"),
            PathBuf::from("/nonexistent"),
            None,
            Box::new(|| Err(ShellError::TokenMissing)),
        );
        let info = mgr.info().expect("info");
        assert_eq!(info.url, "http://127.0.0.1:8765");
        assert_eq!(info.token.as_deref(), Some("dev-token"));
        assert!(matches!(mgr.restart(), Err(ShellError::DevModeManaged)));
    }

    #[test]
    fn bundled_python_layout() {
        assert_eq!(
            bundled_python(Path::new("/A.app/Contents/Resources")),
            PathBuf::from("/A.app/Contents/Resources/backend/python/bin/python3")
        );
    }

    /// Fake studiod: answers `/health` for `n` connections.
    fn fake_studiod(n: usize) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            for _ in 0..n {
                let Ok((mut conn, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 1024];
                let _ = conn.read(&mut buf);
                let body = "{\"ok\":true,\"version\":\"0.1.0\"}";
                let _ = write!(
                    conn,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    #[test]
    fn production_info_reads_runtime_and_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let port = fake_studiod(8);
        std::fs::write(
            runtime_file(dir.path()),
            format!(r#"{{"port": {port}, "pid": 4242}}"#),
        )
        .expect("write");
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = reads.clone();
        let mgr = BackendManager::new(
            None,
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            None,
            Box::new(move || {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(test_token())
            }),
        );
        let info = mgr.info().expect("info");
        assert_eq!(info.url, format!("http://127.0.0.1:{port}"));
        assert_eq!(info.token, Some(test_token()));
        // Second call hits the cache, not the Keychain.
        let again = mgr.info().expect("info");
        assert_eq!(again, info);
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);

        let status = mgr.status();
        assert_eq!(status.mode, "production");
        assert!(status.running);
        assert_eq!(status.pid, Some(4242));
        assert_eq!(status.version.as_deref(), Some("0.1.0"));
        assert_eq!(status.agent_installed, Some(false));
    }

    #[test]
    fn production_status_without_runtime_reports_not_running() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mgr = BackendManager::new(
            None,
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            None,
            Box::new(|| Err(ShellError::TokenMissing)),
        );
        let status = mgr.status();
        assert!(!status.running);
        assert_eq!(status.url, None);
        assert!(status.error.is_some());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn production_info_without_studiod_fails_with_turkish_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mgr = BackendManager::new(
            None,
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            None,
            Box::new(|| Err(ShellError::TokenMissing)),
        );
        let err = mgr.info().expect_err("no studiod");
        assert_eq!(err.code(), "backend_start_failed");
        assert!(err.to_string().contains("başlatılamadı"));
    }
}
