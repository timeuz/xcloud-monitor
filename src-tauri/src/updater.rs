//! Signed auto-update (tauri-plugin-updater) driven from the Rust side.
//!
//! Releases are signed with the project's minisign key (the public half lives in tauri.conf.json);
//! the plugin refuses any package whose signature does not verify. The frontend only asks "is there
//! an update?" and "install it".

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES_URL: &str = "https://github.com/timeuz/xcloud-monitor/releases/latest";

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    /// false when the app cannot replace itself (Linux outside an AppImage or a system package): the UI then points to the release page.
    pub installable: bool,
}

/// True when `exe` sits in a system prefix, i.e. it was installed by a .deb/.rpm package.
#[cfg(any(target_os = "linux", test))]
fn is_system_package_path(exe: &std::path::Path) -> bool {
    exe.starts_with("/usr/") && !exe.starts_with("/usr/local/")
}

/// Linux updates in place from an AppImage, or from a .deb/.rpm through the plugin's pkexec install
/// (a graphical password prompt). A bare binary, such as `tauri dev`, cannot replace itself.
pub fn can_self_update() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
            || std::env::current_exe().map(|p| is_system_package_path(&p)).unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Turns the plugin's raw errors into something a person can act on.
fn friendly_update_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("valid release json") || lower.contains("404") || lower.contains("not found") {
        "Nenhuma atualização publicada: o endereço de atualização não respondeu (a última release ainda não tem o arquivo latest.json, ou o repositório é privado e o app não consegue ler).".into()
    } else if lower.contains("error sending request") || lower.contains("dns") || lower.contains("connect") {
        "Sem conexão com o GitHub para verificar atualizações.".into()
    } else if lower.contains("signature") {
        "A assinatura da atualização não confere com a chave do app; a atualização foi recusada por segurança.".into()
    } else {
        format!("Falha ao verificar atualizações: {raw}")
    }
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| friendly_update_error(&e.to_string()))?;
    let Some(update) = found else {
        *app.state::<PendingUpdate>().0.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return Ok(None);
    };
    let info = UpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        notes: update.body.clone(),
        installable: can_self_update(),
    };
    *app.state::<PendingUpdate>().0.lock().unwrap_or_else(|p| p.into_inner()) = Some(update);
    Ok(Some(info))
}

/// Downloads, verifies the signature, installs and restarts. Only acts on the update found by the last check.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if !can_self_update() {
        return Err("Esta instalação não se atualiza sozinha; baixe a nova versão na página de releases.".into());
    }
    let update = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or_else(|| "Nenhuma atualização pendente: verifique novamente.".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("Falha ao instalar a atualização: {e}"))?;
    app.restart()
}

/// Opens the project's release page in the default browser. The URL is fixed on purpose: the webview
/// never gets to choose what the OS opens.
#[tauri::command]
pub fn open_releases_page() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let status = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd").args(["/C", "start", "", RELEASES_URL]).creation_flags(0x0800_0000).status()
    };
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(RELEASES_URL).status();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(RELEASES_URL).status();
    status.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_errors_are_translated() {
        assert!(friendly_update_error("Could not fetch a valid release JSON from the remote").contains("latest.json"));
        assert!(friendly_update_error("error sending request for url").contains("Sem conexão"));
        assert!(friendly_update_error("the signature is invalid").contains("assinatura"));
        assert!(friendly_update_error("boom").contains("boom"));
    }

    #[test]
    fn releases_url_is_the_projects_https_page() {
        assert!(RELEASES_URL.starts_with("https://github.com/timeuz/xcloud-monitor/"));
    }

    #[test]
    fn update_info_serializes_for_the_ui() {
        let v = serde_json::to_value(UpdateInfo {
            current_version: "1.0.0".into(),
            version: "1.1.0".into(),
            notes: None,
            installable: true,
        })
        .unwrap();
        assert_eq!(v["currentVersion"], "1.0.0");
        assert_eq!(v["installable"], true);
    }
}

#[cfg(test)]
mod path_tests {
    use super::is_system_package_path;
    use std::path::Path;

    #[test]
    fn detects_package_installs() {
        assert!(is_system_package_path(Path::new("/usr/bin/app")));
        assert!(!is_system_package_path(Path::new("/usr/local/bin/app")));
        assert!(!is_system_package_path(Path::new("/home/u/xcloud/target/debug/app")));
    }
}
