//! studiod's LaunchAgent (`app.aistudio.studiod`). The plist itself is written by the backend
//! (`studiod install-agent`, see `backend/src/aistudio/__main__.py`); the shell only decides when
//! to (re)install it and asks launchd to (re)start the job.

use std::path::{Path, PathBuf};

pub const LAUNCH_AGENT_LABEL: &str = "app.aistudio.studiod";

pub fn plist_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
}

/// True when the installed plist starts studiod with `python` (i.e. this copy of the app).
/// A plist left behind by an older/moved app bundle points elsewhere and must be reinstalled.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn plist_uses_python(plist: &str, python: &Path) -> bool {
    let Some(python) = python.to_str() else {
        return false;
    };
    let escaped = xml_escape(python);
    let first_arg = |needle: &str| plist.contains(&format!("<string>{needle}</string>"));
    first_arg(python) || first_arg(&escaped)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(target_os = "macos")]
pub use imp::*;

#[cfg(target_os = "macos")]
mod imp {
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    use super::LAUNCH_AGENT_LABEL;
    use crate::error::ShellError;
    use crate::process;

    const LAUNCHCTL: &str = "/bin/launchctl";

    fn domain_target() -> String {
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        format!("gui/{uid}/{LAUNCH_AGENT_LABEL}")
    }

    /// Runs `<python> -m aistudio install-agent` so the plist records the bundled interpreter
    /// (`sys.executable`) and launchd bootstraps the job.
    pub fn install_agent(python: &Path) -> Result<(), ShellError> {
        let mut cmd = Command::new(python);
        cmd.args(["-m", "aistudio", "install-agent"]);
        // The LaunchAgent never sees these; keep install-time paths identical to run-time ones.
        for var in [
            "AISTUDIO_HOME",
            "AISTUDIO_DEV",
            "AISTUDIO_DEV_TOKEN",
            "AISTUDIO_PORT",
            "PYTHONHOME",
            "PYTHONPATH",
            "VIRTUAL_ENV",
        ] {
            cmd.env_remove(var);
        }
        let out = process::run(cmd, Duration::from_secs(60))?;
        if out.success {
            log::info!("LaunchAgent installed: {}", out.stdout.trim());
            Ok(())
        } else {
            let detail = if out.stderr.trim().is_empty() {
                out.stdout.trim().to_owned()
            } else {
                out.stderr.trim().to_owned()
            };
            Err(ShellError::BackendStart(format!(
                "LaunchAgent kurulamadı ({detail})"
            )))
        }
    }

    /// `launchctl kickstart [-k] gui/<uid>/app.aistudio.studiod`. With `kill`, a running instance
    /// is terminated first (restart).
    pub fn kickstart(kill: bool) -> Result<(), ShellError> {
        let mut cmd = Command::new(LAUNCHCTL);
        cmd.arg("kickstart");
        if kill {
            cmd.arg("-k");
        }
        cmd.arg(domain_target());
        let out = process::run(cmd, Duration::from_secs(15))?;
        if out.success {
            Ok(())
        } else {
            Err(ShellError::BackendStart(format!(
                "launchctl kickstart başarısız ({})",
                out.stderr.trim()
            )))
        }
    }

    /// Whether launchd currently knows the job (`launchctl print` succeeds).
    pub fn is_loaded() -> bool {
        let mut cmd = Command::new(LAUNCHCTL);
        cmd.args(["print", &domain_target()]);
        process::run(cmd, Duration::from_secs(5))
            .map(|o| o.success)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key><string>app.aistudio.studiod</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Applications/AI Studio.app/Contents/Resources/backend/python/bin/python3</string>
      <string>-m</string>
      <string>aistudio</string>
      <string>serve</string>
    </array>
  </dict>
</plist>"#;

    #[test]
    fn plist_path_is_in_launch_agents() {
        assert_eq!(
            plist_path(Path::new("/Users/u")),
            PathBuf::from("/Users/u/Library/LaunchAgents/app.aistudio.studiod.plist")
        );
    }

    #[test]
    fn detects_matching_interpreter() {
        let ours =
            Path::new("/Applications/AI Studio.app/Contents/Resources/backend/python/bin/python3");
        assert!(plist_uses_python(PLIST, ours));
    }

    #[test]
    fn detects_stale_interpreter() {
        let moved = Path::new(
            "/Users/u/Downloads/AI Studio.app/Contents/Resources/backend/python/bin/python3",
        );
        assert!(!plist_uses_python(PLIST, moved));
        // A prefix of the real path must not count as a match.
        assert!(!plist_uses_python(
            PLIST,
            Path::new("/Applications/AI Studio.app/Contents/Resources/backend/python/bin/python")
        ));
    }
}
