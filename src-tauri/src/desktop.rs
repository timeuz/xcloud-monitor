//! Desktop shell: system tray, close-to-tray, autostart and single instance.
//!
//! The point is continuous collection: the 30 s sampler lives in the Rust backend, so as long as
//! the process is alive it keeps recording. Closing the window hides it to the tray instead of
//! quitting, but only when the tray icon was actually created: without a tray there would be no way
//! back to a hidden window, so closing then exits as usual.

use crate::history::History;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

pub const MINIMIZED_ARG: &str = "--minimized";
const META_CLOSE_TO_TRAY: &str = "close_to_tray";

pub struct Desktop {
    tray_ok: AtomicBool,
    collect_item: Mutex<Option<CheckMenuItem<Wry>>>,
}

impl Desktop {
    pub fn new() -> Self {
        Self { tray_ok: AtomicBool::new(false), collect_item: Mutex::new(None) }
    }
    pub fn tray_ok(&self) -> bool {
        self.tray_ok.load(Ordering::SeqCst)
    }
}

/// Window geometry is restored, but never visibility: a window hidden in the tray must not stay
/// hidden after the next launch.
pub fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// True when the close button should hide the window instead of quitting.
pub fn should_hide_on_close(app: &AppHandle) -> bool {
    let desktop = app.state::<Desktop>();
    desktop.tray_ok() && app.state::<History>().close_to_tray()
}

fn quit(app: &AppHandle) {
    let _ = app.save_window_state(window_state_flags());
    app.exit(0);
}

/// Builds the tray icon. Returns false (and logs) when the platform cannot provide one.
pub fn setup_tray(app: &tauri::App) -> bool {
    let handle = app.handle();
    let result: tauri::Result<()> = (|| {
        let history = handle.state::<History>();
        let version = MenuItem::with_id(
            handle,
            "version",
            format!("xCloud Cyber-Monitor v{}", handle.package_info().version),
            false,
            None::<&str>,
        )?;
        let show = MenuItem::with_id(handle, "show", "Abrir xCloud Cyber-Monitor", true, None::<&str>)?;
        let collect = CheckMenuItem::with_id(
            handle,
            "collect",
            "Coletar medições em segundo plano",
            true,
            history.is_enabled(),
            None::<&str>,
        )?;
        let quit_item = MenuItem::with_id(handle, "quit", "Sair (para a coleta)", true, None::<&str>)?;
        let menu = Menu::with_items(handle, &[&version, &PredefinedMenuItem::separator(handle)?, &show, &collect, &PredefinedMenuItem::separator(handle)?, &quit_item])?;

        *handle.state::<Desktop>().collect_item.lock().unwrap_or_else(|p| p.into_inner()) = Some(collect);

        let mut builder = TrayIconBuilder::with_id("main")
            .tooltip("xCloud Cyber-Monitor — coletando medições")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => show_main(app),
                "collect" => {
                    let enabled = {
                        let desktop = app.state::<Desktop>();
                        let guard = desktop.collect_item.lock().unwrap_or_else(|p| p.into_inner());
                        guard.as_ref().and_then(|i| i.is_checked().ok())
                    };
                    if let Some(enabled) = enabled {
                        if let Err(e) = app.state::<History>().set_enabled(enabled) {
                            log::warn!("tray: could not change collection: {e}");
                        }
                    }
                }
                "quit" => quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(handle)?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            handle.state::<Desktop>().tray_ok.store(true, Ordering::SeqCst);
            true
        }
        Err(e) => {
            log::warn!("system tray unavailable ({e}); closing the window will quit the app");
            false
        }
    }
}

/// Keeps the tray checkbox in step with the Settings toggle.
pub fn sync_collect_item(app: &AppHandle, enabled: bool) {
    let desktop = app.state::<Desktop>();
    let guard = desktop.collect_item.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(item) = guard.as_ref() {
        let _ = item.set_checked(enabled);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub close_to_tray: bool,
    pub tray_available: bool,
    pub autostart: bool,
}

#[tauri::command]
pub fn desktop_settings(app: AppHandle) -> DesktopSettings {
    DesktopSettings {
        close_to_tray: app.state::<History>().close_to_tray(),
        tray_available: app.state::<Desktop>().tray_ok(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<History>().set_meta_flag(META_CLOSE_TO_TRAY, enabled)
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable().map_err(|e| e.to_string())
    } else {
        launcher.disable().map_err(|e| e.to_string())
    }
}

pub fn meta_close_to_tray_key() -> &'static str {
    META_CLOSE_TO_TRAY
}
