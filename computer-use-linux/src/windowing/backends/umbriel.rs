use crate::command_runner;
use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{native_window_id, WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::HashSet;
use std::process::Command as StdCommand;
use tokio::process::Command;

pub const UMBRIEL_BACKEND: &str = "umbriel";

pub fn probe() -> BackendProbe {
    let mut command = StdCommand::new("umbriel");
    command.args(["windows", "--json"]);
    let readiness = command_runner::output_blocking(&mut command, "probe Umbriel windows")
        .and_then(|output| {
            if !output.status.success() {
                bail!(
                    "umbriel windows --json failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            parse_windows(&String::from_utf8_lossy(&output.stdout))
        });
    let can_verify_focus = readiness.as_ref().is_ok_and(|windows| {
        !windows.is_empty()
            && windows
                .iter()
                .all(|window| window.keyboard_focused.is_some())
    });
    BackendProbe {
        id: UMBRIEL_BACKEND,
        ok: readiness.is_ok(),
        can_list_windows: readiness.is_ok(),
        can_focus_apps: can_verify_focus,
        can_focus_windows: can_verify_focus,
        detail: match readiness {
            Ok(_) if can_verify_focus => "Umbriel JSON window IPC and keyboard-focus verification are available".to_string(),
            Ok(_) => "Umbriel window discovery is available, but keyboard-focus verification is unavailable".to_string(),
            Err(error) => format!("Umbriel window IPC unavailable: {error:#}"),
        },
    }
}

async fn snapshot() -> Result<Vec<UmbrielWindow>> {
    let mut command = Command::new("umbriel");
    command.args(["windows", "--json"]);
    let output = command_runner::output(command, "list Umbriel windows").await?;
    if !output.status.success() {
        bail!(
            "umbriel windows --json failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    parse_windows(&String::from_utf8_lossy(&output.stdout))
}

fn parse_windows(json: &str) -> Result<Vec<UmbrielWindow>> {
    let windows: Vec<UmbrielWindow> =
        serde_json::from_str(json).context("failed to parse umbriel windows --json output")?;
    let mut ids = HashSet::new();
    for window in &windows {
        if window.id.is_empty() {
            bail!("Umbriel window has an empty native ID");
        }
        if !ids.insert(native_window_id(&window.id)) {
            bail!("Umbriel window IDs are ambiguous in the numeric window-ID namespace");
        }
    }
    Ok(windows)
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    let mut windows: Vec<_> = snapshot()
        .await?
        .into_iter()
        .map(WindowInfo::from)
        .collect();
    windows.sort_by_key(|window| window.window_id);
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub async fn activate_window(window_id: u64) -> Result<()> {
    // Resolve against a fresh snapshot: never truncate or guess the native ID,
    // and refuse a stale target or a collision before sending a focus action.
    let native = snapshot()
        .await?
        .into_iter()
        .find(|window| native_window_id(&window.id) == window_id)
        .with_context(|| format!("No Umbriel window matched window_id {window_id}"))?;
    if native.keyboard_focused.is_none() {
        bail!("Umbriel window IPC does not expose keyboard_focused; refusing unverified window activation");
    }
    let mut command = Command::new("umbriel");
    command.args(["msg", &format!("window-focus:{}", native.id)]);
    let output = command_runner::output(command, "focus Umbriel window").await?;
    if !output.status.success() {
        bail!(
            "Umbriel focus failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct UmbrielWindow {
    id: String,
    title: Option<String>,
    app_id: Option<String>,
    pid: Option<i64>,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    keyboard_focused: Option<bool>,
    xwayland: bool,
    #[serde(default)]
    tab_hidden: bool,
}

impl From<UmbrielWindow> for WindowInfo {
    fn from(window: UmbrielWindow) -> Self {
        Self {
            window_id: native_window_id(&window.id),
            title: window.title,
            app_id: window.app_id,
            wm_class: None,
            pid: window
                .pid
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid != 0),
            bounds: Some(WindowBounds {
                x: Some(window.x),
                y: Some(window.y),
                width: window.w,
                height: window.h,
            }),
            workspace: None,
            // Activation can identify an overview card without keyboard focus.
            focused: window.keyboard_focused.unwrap_or(false),
            hidden: window.tab_hidden,
            client_type: Some(if window.xwayland { "x11" } else { "wayland" }.to_string()),
            backend: UMBRIEL_BACKEND.to_string(),
            terminal: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: &str = r#"{"id":"ffd00010689f4b4ded78c14a388e58ce","app_id":"editor","title":"Document","pid":123,"x":-100,"y":20,"w":800,"h":600,"active":false,"focused":true,"xwayland":false}"#;

    #[test]
    fn remembered_workspace_focus_is_not_keyboard_focus() {
        let records = parse_windows(&format!("[{WINDOW}]")).unwrap();
        let window = WindowInfo::from(records.into_iter().next().unwrap());
        assert!(!window.focused);
        assert_eq!(window.pid, Some(123));
        assert_eq!(window.bounds.unwrap().x, Some(-100));
        assert_eq!(window.client_type.as_deref(), Some("wayland"));
    }

    #[test]
    fn overview_activation_is_not_keyboard_focus() {
        let active = WINDOW.replace("\"active\":false", "\"active\":true");
        for extra in [
            "",
            ",\"keyboard_focused\":false",
            ",\"keyboard_focused\":true",
        ] {
            let json = format!("[{}{extra}}}]", active.trim_end_matches('}'));
            let records = parse_windows(&json).unwrap();
            let window = WindowInfo::from(records.into_iter().next().unwrap());
            assert_eq!(window.focused, extra.ends_with("true"));
        }
    }

    #[test]
    fn native_ids_stay_stable_when_windows_reorder() {
        let other = WINDOW.replace(
            "ffd00010689f4b4ded78c14a388e58ce",
            "ffd00010689f4b4ded78c14a388e58cf",
        );
        let a = parse_windows(&format!("[{WINDOW},{other}]")).unwrap();
        let b = parse_windows(&format!("[{other},{WINDOW}]")).unwrap();
        assert_eq!(native_window_id(&a[0].id), native_window_id(&b[1].id));
        assert_ne!(native_window_id(&a[0].id), native_window_id(&a[1].id));
    }

    #[test]
    fn ambiguous_or_missing_native_ids_fail_closed() {
        assert!(parse_windows(&format!("[{WINDOW},{WINDOW}]")).is_err());
        assert!(parse_windows(&format!(
            "[{}]",
            WINDOW.replace("ffd00010689f4b4ded78c14a388e58ce", "")
        ))
        .is_err());
        assert!(parse_windows(r#"[{"id":"missing-fields"}]"#).is_err());
        assert!(parse_windows("[]").unwrap().is_empty());
    }
}
