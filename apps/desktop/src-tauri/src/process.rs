//! Small helpers for running short-lived system tools (`open`, `launchctl`, `osascript`,
//! the bundled Python) with a timeout, so a hung tool never blocks the shell forever.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::ShellError;

#[derive(Debug)]
pub struct Output {
    pub success: bool,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub stdout: String,
    pub stderr: String,
}

/// Runs `cmd` to completion (stdin closed, output captured) or kills it after `timeout`.
pub fn run(mut cmd: Command, timeout: Duration) -> Result<Output, ShellError> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ShellError::Process(format!("{program}: {e}")))?;
    // Drain pipes on threads so a chatty child can't deadlock on a full pipe buffer.
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(pipe) = stdout.as_mut() {
            let _ = pipe.read_to_string(&mut s);
        }
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_string(&mut s);
        }
        s
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ShellError::Process(format!(
                    "{program} {} saniyede tamamlanmadı",
                    timeout.as_secs()
                )));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(ShellError::Process(format!("{program}: {e}"))),
        }
    };
    Ok(Output {
        success: status.success(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// Spawns a fire-and-forget process (e.g. `open -a Editor path`); reaps it on a thread.
pub fn spawn_detached(mut cmd: Command) -> Result<(), ShellError> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| ShellError::Process(format!("{program}: {e}")))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn captures_output() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo out; echo err 1>&2; exit 3"]);
        let out = run(cmd, Duration::from_secs(5)).expect("run");
        assert!(!out.success);
        assert_eq!(out.stdout.trim(), "out");
        assert_eq!(out.stderr.trim(), "err");
    }

    #[test]
    fn kills_on_timeout() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 5"]);
        let started = Instant::now();
        assert!(run(cmd, Duration::from_millis(200)).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn reports_missing_program() {
        let cmd = Command::new("/nonexistent/definitely-not-here");
        assert!(run(cmd, Duration::from_secs(1)).is_err());
    }
}
