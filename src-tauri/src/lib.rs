mod ai;
mod bufferbloat;
mod desktop;
mod analysis;
mod history;
mod network;
mod report;
mod route;
mod session;
mod udp;
mod updater;

use network::{
    probe_all_strategic, probe_host, TelemetryProbeResponse,
};

#[tauri::command]
fn is_desktop_native() -> bool {
    true
}

#[tauri::command]
async fn probe_telemetry(custom_host: Option<String>) -> Result<TelemetryProbeResponse, String> {
    // Run CPU/blocking network probes off the main async reactor
    let result = tauri::async_runtime::spawn_blocking(move || {
        probe_all_strategic(custom_host)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
async fn probe_single_host(host: String, port: Option<u16>) -> Result<(Option<f64>, bool), String> {
    let p = port.unwrap_or(443);
    let result = tauri::async_runtime::spawn_blocking(move || {
        probe_host(&host, p)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
async fn run_bufferbloat(
    history: tauri::State<'_, history::History>,
) -> Result<bufferbloat::BufferbloatResponse, String> {
    let result = bufferbloat::run().await?;
    if history.is_enabled() {
        if let Err(e) = history.record_bufferbloat(history::now_secs(), &result) {
            log::warn!("history: failed to record bufferbloat: {e}");
        }
    }
    Ok(result)
}

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // A second launch must bring the existing window back (also the way out of a hidden tray state).
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show_main(app)))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(desktop::window_state_flags())
                    .build(),
            )
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec![desktop::MINIMIZED_ARG]),
            ));
    }

    builder
        .manage(desktop::Desktop::new())
        .manage(updater::PendingUpdate::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && desktop::should_hide_on_close(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let history = history::db_path(app.handle())
                .and_then(|path| history::History::open(&path))
                .unwrap_or_else(|e| {
                    log::error!("history database unavailable ({e}); falling back to memory-only");
                    history::History::open_in_memory().expect("in-memory sqlite")
                });
            app.manage(history);
            history::spawn_sampler(app.handle().clone());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let tray_ok = desktop::setup_tray(app);

            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                // The window is created hidden (no flash of default geometry before the saved one is
                // restored). Autostart launches stay in the tray, but only if a tray exists.
                let start_hidden = tray_ok && std::env::args().any(|a| a == desktop::MINIMIZED_ARG);
                if !start_hidden {
                    desktop::show_main(app.handle());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_desktop_native,
            probe_telemetry,
            probe_single_host,
            run_bufferbloat,
            route::run_traceroute,
            ai::ai_status,
            ai::ai_verify,
            ai::ai_save_key,
            ai::ai_chat,
            history::history_stats,
            history::history_analysis,
            history::history_series,
            history::history_udp_runs,
            udp::run_udp_test,
            session::detect_session_peers,
            session::measure_session_peer,
            session::history_session_runs,
            history::history_export_report,
            history::history_set_enabled,
            history::history_clear,
            history::history_export_csv,
            desktop::desktop_settings,
            desktop::set_close_to_tray,
            desktop::set_autostart,
            updater::app_version,
            updater::update_check,
            updater::update_install,
            updater::open_releases_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
