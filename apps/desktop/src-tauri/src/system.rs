//! Hand-offs to other apps: browser, Finder, code editors.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{ShellError, ShellResult};
use crate::process;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorId {
    Vscode,
    Cursor,
    Zed,
    Xcode,
}

struct EditorSpec {
    id: EditorId,
    name: &'static str,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    bundle_id: &'static str,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    cli: Option<&'static str>,
}

const EDITORS: [EditorSpec; 4] = [
    EditorSpec {
        id: EditorId::Vscode,
        name: "Visual Studio Code",
        bundle_id: "com.microsoft.VSCode",
        cli: Some("code"),
    },
    EditorSpec {
        id: EditorId::Cursor,
        name: "Cursor",
        bundle_id: "com.todesktop.230313mzl4w4u92",
        cli: Some("cursor"),
    },
    EditorSpec {
        id: EditorId::Zed,
        name: "Zed",
        bundle_id: "dev.zed.Zed",
        cli: Some("zed"),
    },
    EditorSpec {
        id: EditorId::Xcode,
        name: "Xcode",
        bundle_id: "com.apple.dt.Xcode",
        cli: None,
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub id: EditorId,
    pub name: String,
    /// App bundle path (macOS) or CLI path.
    pub path: String,
}

/// Only web and mail links leave the app (no `file:`, `javascript:` or custom schemes).
pub fn validate_external_url(raw: &str) -> ShellResult<Url> {
    let url = Url::parse(raw.trim()).map_err(|_| ShellError::InvalidUrl(raw.to_owned()))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        "mailto" => Ok(url),
        _ => Err(ShellError::InvalidUrl(raw.to_owned())),
    }
}

pub fn validate_existing_path(raw: &str) -> ShellResult<PathBuf> {
    let path = PathBuf::from(raw);
    if raw.trim().is_empty() || !path.is_absolute() {
        return Err(ShellError::InvalidPath(format!(
            "mutlak yol gerekli: {raw}"
        )));
    }
    if !path.exists() {
        return Err(ShellError::InvalidPath(format!("bulunamadı: {raw}")));
    }
    Ok(path)
}

/// Xcode projects open in Xcode; everything else in the preferred/first available editor.
pub fn choose_editor(
    path: &Path,
    available: &[EditorId],
    preferred: Option<EditorId>,
) -> Option<EditorId> {
    if let Some(p) = preferred.filter(|p| available.contains(p)) {
        return Some(p);
    }
    let is_xcode_project = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e, "xcodeproj" | "xcworkspace" | "playground"));
    if is_xcode_project && available.contains(&EditorId::Xcode) {
        return Some(EditorId::Xcode);
    }
    [
        EditorId::Vscode,
        EditorId::Cursor,
        EditorId::Zed,
        EditorId::Xcode,
    ]
    .into_iter()
    .find(|e| available.contains(e))
}

#[cfg(target_os = "macos")]
fn opener() -> Command {
    Command::new("/usr/bin/open")
}

pub fn open_external(raw: &str) -> ShellResult<()> {
    let url = validate_external_url(raw)?;
    #[cfg(target_os = "macos")]
    let mut cmd = opener();
    #[cfg(not(target_os = "macos"))]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(url.as_str());
    process::spawn_detached(cmd)
}

pub fn reveal_in_finder(raw: &str) -> ShellResult<()> {
    let path = validate_existing_path(raw)?;
    #[cfg(target_os = "macos")]
    let cmd = {
        let mut cmd = opener();
        cmd.arg("-R").arg(&path);
        cmd
    };
    #[cfg(not(target_os = "macos"))]
    let cmd = {
        let dir = if path.is_dir() {
            path.clone()
        } else {
            path.parent().map(Path::to_path_buf).unwrap_or(path.clone())
        };
        let mut cmd = Command::new("xdg-open");
        cmd.arg(dir);
        cmd
    };
    process::spawn_detached(cmd)
}

#[cfg(target_os = "macos")]
fn find_app(spec: &EditorSpec) -> Option<PathBuf> {
    use std::time::Duration;

    let file = format!("{}.app", spec.name);
    let mut candidates = vec![PathBuf::from("/Applications").join(&file)];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join("Applications").join(&file));
    }
    if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
        return Some(found);
    }
    // Spotlight lookup by bundle id (renamed or relocated apps).
    let mut cmd = Command::new("/usr/bin/mdfind");
    cmd.arg(format!("kMDItemCFBundleIdentifier == '{}'", spec.bundle_id));
    let out = process::run(cmd, Duration::from_secs(3)).ok()?;
    out.stdout
        .lines()
        .map(str::trim)
        .find(|l| l.ends_with(".app"))
        .map(PathBuf::from)
}

#[cfg(not(target_os = "macos"))]
fn find_app(spec: &EditorSpec) -> Option<PathBuf> {
    let cli = spec.cli?;
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(cli))
            .find(|candidate| candidate.is_file())
    })
}

pub fn detect_editors() -> Vec<EditorInfo> {
    EDITORS
        .iter()
        .filter_map(|spec| {
            find_app(spec).map(|path| EditorInfo {
                id: spec.id,
                name: spec.name.to_owned(),
                path: path.display().to_string(),
            })
        })
        .collect()
}

/// Opens a file or folder in an editor (worktree hand-off, spec §18 "işi devralma").
pub fn open_in_editor(raw: &str, preferred: Option<EditorId>) -> ShellResult<EditorInfo> {
    let path = validate_existing_path(raw)?;
    let editors = detect_editors();
    let ids: Vec<EditorId> = editors.iter().map(|e| e.id).collect();
    let chosen = choose_editor(&path, &ids, preferred).ok_or(ShellError::NoEditor)?;
    let editor = editors
        .into_iter()
        .find(|e| e.id == chosen)
        .ok_or(ShellError::NoEditor)?;
    #[cfg(target_os = "macos")]
    let cmd = {
        let mut cmd = opener();
        cmd.arg("-a").arg(&editor.path).arg(&path);
        cmd
    };
    #[cfg(not(target_os = "macos"))]
    let cmd = {
        let mut cmd = Command::new(&editor.path);
        cmd.arg(&path);
        cmd
    };
    process::spawn_detached(cmd)?;
    Ok(editor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_urls_are_restricted() {
        assert!(validate_external_url("https://github.com/org/repo/pull/1").is_ok());
        assert!(validate_external_url("http://localhost:3000").is_ok());
        assert!(validate_external_url("mailto:someone@example.com").is_ok());
        for bad in [
            "",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "aistudio://approval/1",
            "ssh://host",
            "https://",
            "not a url",
        ] {
            assert!(validate_external_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn paths_must_be_absolute_and_exist() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().to_string_lossy().into_owned();
        assert!(validate_existing_path(&p).is_ok());
        assert!(validate_existing_path("relative/path").is_err());
        assert!(validate_existing_path("").is_err());
        assert!(validate_existing_path(&format!("{p}/missing")).is_err());
    }

    #[test]
    fn chooses_editor() {
        let all = [EditorId::Cursor, EditorId::Xcode, EditorId::Vscode];
        let repo = Path::new("/Users/u/src/repo");
        assert_eq!(choose_editor(repo, &all, None), Some(EditorId::Vscode));
        assert_eq!(
            choose_editor(repo, &all, Some(EditorId::Cursor)),
            Some(EditorId::Cursor)
        );
        // Preferred but not installed → default order.
        assert_eq!(
            choose_editor(repo, &[EditorId::Cursor], Some(EditorId::Zed)),
            Some(EditorId::Cursor)
        );
        assert_eq!(
            choose_editor(Path::new("/p/App.xcodeproj"), &all, None),
            Some(EditorId::Xcode)
        );
        assert_eq!(
            choose_editor(Path::new("/p/App.xcodeproj"), &[EditorId::Zed], None),
            Some(EditorId::Zed)
        );
        assert_eq!(choose_editor(repo, &[], None), None);
    }

    #[test]
    fn editor_ids_serialize_lowercase() {
        assert_eq!(
            serde_json::to_value(EditorId::Vscode).expect("json"),
            "vscode"
        );
        let id: EditorId = serde_json::from_str("\"cursor\"").expect("json");
        assert_eq!(id, EditorId::Cursor);
    }
}
