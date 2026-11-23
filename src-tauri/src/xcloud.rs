//! xCloud live queue / catalog service (native port of the former Express `/api/xcloud/*` routes).
//!
//! The gsToken is read from the local xStreaming config. Paths are resolved per-OS via `dirs`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const BASE_URI: &str = "https://brs.core.gssv-play-prod.xboxlive.com";
const REGION_LABEL: &str = "brazilsouth (São Paulo)";
const USER_AGENT: &str = "Mozilla/5.0 (compatible; xCloudCyberMonitor)";
const CATALOG_TTL: Duration = Duration::from_secs(30 * 60);

struct Session {
    gs_token: String,
    base_uri: String,
    market: String,
    gamertag: String,
    gamerpic: String,
}

#[derive(Clone)]
struct ProductDetails {
    title: String,
    poster: Option<String>,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_millis(4500))
            .user_agent(USER_AGENT)
            .build()
            .expect("failed to build HTTP client")
    })
}

fn product_cache() -> &'static Mutex<HashMap<String, ProductDetails>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ProductDetails>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

type TitleCatalog = (Vec<(String, String)>, Option<Instant>);

fn title_catalog() -> &'static Mutex<TitleCatalog> {
    static CATALOG: OnceLock<Mutex<TitleCatalog>> = OnceLock::new();
    CATALOG.get_or_init(|| Mutex::new((Vec::new(), None)))
}

/// Candidate locations of the xStreaming config, in priority order.
fn config_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(dir) = dirs::config_dir() {
        paths.push(dir.join("xstreaming").join("config.json"));
    }
    if let Some(home) = dirs::home_dir() {
        let legacy = home.join(".config").join("xstreaming").join("config.json");
        if !paths.contains(&legacy) {
            paths.push(legacy);
        }
    }
    paths
}

fn read_session() -> Option<Session> {
    for path in config_candidates() {
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(data) = serde_json::from_str::<Value>(&raw) else { continue };
        let xc = &data["user"]["streamToken"]["xCloudToken"]["data"];
        let Some(token) = xc["gsToken"].as_str().filter(|t| !t.is_empty()) else { continue };
        return Some(Session {
            gs_token: token.to_string(),
            base_uri: BASE_URI.to_string(),
            market: xc["market"].as_str().unwrap_or("BR").to_string(),
            gamertag: data["user"]["gamertag"].as_str().unwrap_or("Gamer").to_string(),
            gamerpic: data["user"]["gamerpic"].as_str().unwrap_or("").to_string(),
        });
    }
    None
}

fn no_session_message() -> String {
    let places: Vec<String> = config_candidates()
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    format!(
        "xStreaming não encontrado ({}). Abra o xStreaming e faça login para sincronizar sua fila ao vivo.",
        places.join(" ou ")
    )
}

/// Detects an active xStreaming stream by looking for its Electron audio service process.
fn is_game_currently_streaming() -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("ps")
            .arg("aux")
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout).lines().any(|l| {
                    let l = l.to_lowercase();
                    l.contains("xstreaming") && l.contains("audio.mojom.audioservice")
                })
            })
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*xstreaming*' } | Select-Object -ExpandProperty CommandLine",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("audio.mojom.audioservice"))
            .unwrap_or(false)
    }
}

fn auth_headers(session: &Session) -> Vec<(&'static str, String)> {
    vec![
        ("Authorization", format!("Bearer {}", session.gs_token)),
        ("Content-Type", "application/json".to_string()),
        ("Origin", "https://www.xbox.com".to_string()),
        ("Referer", "https://www.xbox.com/".to_string()),
    ]
}

/// GET returning parsed JSON when the body is valid JSON (any HTTP status), `None` otherwise.
async fn get_json(url: &str, headers: &[(&'static str, String)]) -> Option<Value> {
    let mut req = client().get(url);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let resp = req.send().await.ok()?;
    resp.json::<Value>().await.ok()
}

async fn resolve_product_details(product_ids: &[String]) -> HashMap<String, ProductDetails> {
    let missing: Vec<String> = {
        let cache = product_cache().lock().unwrap();
        product_ids
            .iter()
            .filter(|id| !cache.contains_key(&id.to_uppercase()))
            .cloned()
            .collect()
    };

    for chunk in missing.chunks(20) {
        let url = format!(
            "https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds={}&market=BR&languages=pt-BR",
            chunk.join(",")
        );
        let Some(data) = get_json(&url, &[]).await else { continue };
        let Some(products) = data["Products"].as_array() else { continue };
        let mut cache = product_cache().lock().unwrap();
        for p in products {
            let pid = p["ProductId"].as_str().unwrap_or("").to_uppercase();
            let loc = &p["LocalizedProperties"][0];
            let title = loc["ProductTitle"].as_str().unwrap_or(&pid).to_string();
            let poster = loc["Images"]
                .as_array()
                .and_then(|imgs| {
                    imgs.iter().find(|i| {
                        matches!(i["ImagePurpose"].as_str(), Some("BoxArt") | Some("Poster"))
                    })
                })
                .and_then(|i| i["Uri"].as_str())
                .map(|u| if u.starts_with("//") { format!("https:{u}") } else { u.to_string() });
            cache.insert(pid, ProductDetails { title, poster });
        }
    }

    let cache = product_cache().lock().unwrap();
    product_ids
        .iter()
        .filter_map(|id| cache.get(&id.to_uppercase()).map(|d| (id.clone(), d.clone())))
        .collect()
}

async fn get_title_catalog(session: &Session) -> Vec<(String, String)> {
    {
        let guard = title_catalog().lock().unwrap();
        if let (items, Some(at)) = &*guard {
            if !items.is_empty() && at.elapsed() < CATALOG_TTL {
                return items.clone();
            }
        }
    }

    let url = format!("{}/v2/titles", session.base_uri);
    if let Some(data) = get_json(&url, &auth_headers(session)).await {
        if let Some(results) = data["results"].as_array() {
            let items: Vec<(String, String)> = results
                .iter()
                .map(|r| {
                    (
                        r["titleId"].as_str().unwrap_or("").to_string(),
                        r["details"]["productId"].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect();
            *title_catalog().lock().unwrap() = (items.clone(), Some(Instant::now()));
            return items;
        }
    }
    title_catalog().lock().unwrap().0.clone()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct WaitTimes {
    total: f64,
    provisioning: f64,
    allocation: f64,
}

async fn fetch_wait_times(session: &Session, title_id: &str) -> WaitTimes {
    let url = format!("{}/v1/waittime/{}", session.base_uri, title_id);
    let data = get_json(&url, &auth_headers(session)).await.unwrap_or(Value::Null);
    let total = data["estimatedTotalWaitTimeInSeconds"].as_f64().unwrap_or(0.0);
    let provisioning = data["estimatedProvisioningTimeInSeconds"]
        .as_f64()
        .filter(|v| *v != 0.0)
        .unwrap_or(10.0);
    let allocation = data["estimatedAllocationTimeInSeconds"]
        .as_f64()
        .filter(|v| *v != 0.0)
        .unwrap_or((total - 10.0).max(0.0));
    WaitTimes { total, provisioning, allocation }
}

fn minutes(seconds: f64) -> f64 {
    (seconds / 60.0 * 10.0).round() / 10.0
}

#[tauri::command]
pub async fn xcloud_user_session() -> Value {
    match read_session() {
        None => json!({
            "connected": false,
            "message": no_session_message(),
        }),
        Some(s) => json!({
            "connected": true,
            "gamertag": s.gamertag,
            "gamerpic": s.gamerpic,
            "region": REGION_LABEL,
            "market": s.market,
            "baseUri": s.base_uri,
        }),
    }
}

#[tauri::command]
pub async fn xcloud_active_game(title_id: Option<String>) -> Value {
    let Some(session) = read_session() else {
        return json!({ "ok": false, "connected": false, "message": no_session_message() });
    };

    let mut target_title = title_id
        .map(|t| t.trim().to_uppercase())
        .filter(|t| !t.is_empty());
    let mut product_id = String::new();
    let mut last_played: Option<String> = None;

    if target_title.is_none() {
        let url = format!("{}/v2/titles/mru", session.base_uri);
        if let Some(data) = get_json(&url, &auth_headers(&session)).await {
            let top = &data["results"][0];
            if let Some(id) = top["titleId"].as_str() {
                target_title = Some(id.to_string());
                product_id = top["details"]["productId"].as_str().unwrap_or("").to_string();
                last_played = top["titleHistory"]["lastTimePlayed"].as_str().map(String::from);
            }
        }
    }
    // No selected title and no play history: report that instead of inventing a game.
    let Some(title_id) = target_title else {
        return json!({
            "ok": true,
            "connected": true,
            "hasTitle": false,
            "isCurrentlyPlaying": false,
            "titleId": "",
            "titleName": "",
            "estimatedWaitSeconds": 0,
            "estimatedWaitMinutes": 0,
            "provisioningSeconds": 0,
            "allocationSeconds": 0,
            "gamertag": session.gamertag,
            "gamerpic": session.gamerpic,
            "region": REGION_LABEL,
            "source": "xstreaming_live",
            "updatedAt": now_ms(),
        });
    };

    let wait = fetch_wait_times(&session, &title_id).await;

    let mut title_name = title_id.clone();
    let mut poster = String::new();
    if !product_id.is_empty() {
        let details = resolve_product_details(&[product_id.clone()]).await;
        if let Some(d) = details.get(&product_id) {
            title_name = d.title.clone();
            poster = d.poster.clone().unwrap_or_default();
        }
    }

    let playing = tauri::async_runtime::spawn_blocking(is_game_currently_streaming)
        .await
        .unwrap_or(false);

    json!({
        "ok": true,
        "connected": true,
        "hasTitle": true,
        "isCurrentlyPlaying": playing,
        "titleId": title_id,
        "titleName": title_name,
        "productId": product_id,
        "posterUrl": poster,
        "estimatedWaitSeconds": wait.total,
        "estimatedWaitMinutes": minutes(wait.total),
        "provisioningSeconds": wait.provisioning,
        "allocationSeconds": wait.allocation,
        "lastTimePlayed": last_played,
        "gamertag": session.gamertag,
        "gamerpic": session.gamerpic,
        "region": REGION_LABEL,
        "source": "xstreaming_live",
        "updatedAt": now_ms(),
    })
}

#[tauri::command]
pub async fn xcloud_recent_games() -> Value {
    let Some(session) = read_session() else {
        return json!({ "ok": false, "games": [] });
    };
    let url = format!("{}/v2/titles/mru", session.base_uri);
    let data = get_json(&url, &auth_headers(&session)).await.unwrap_or(Value::Null);
    let results = data["results"].as_array().cloned().unwrap_or_default();
    let product_ids: Vec<String> = results
        .iter()
        .filter_map(|r| r["details"]["productId"].as_str().map(String::from))
        .collect();
    let details = resolve_product_details(&product_ids).await;

    let games: Vec<Value> = results
        .iter()
        .map(|r| {
            let pid = r["details"]["productId"].as_str().unwrap_or("");
            let det = details.get(pid);
            json!({
                "titleId": r["titleId"],
                "productId": pid,
                "titleName": det.map(|d| d.title.clone()).unwrap_or_else(|| r["titleId"].as_str().unwrap_or("").to_string()),
                "posterUrl": det.and_then(|d| d.poster.clone()).unwrap_or_default(),
                "lastTimePlayed": r["titleHistory"]["lastTimePlayed"],
            })
        })
        .collect();

    json!({ "ok": true, "games": games })
}

#[tauri::command]
pub async fn xcloud_search_games(query: String) -> Value {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return json!({ "ok": true, "results": [] });
    }
    let Some(session) = read_session() else {
        return json!({ "ok": false, "message": "xStreaming não conectado", "results": [] });
    };

    let normalize = |s: &str| -> String {
        s.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
    };
    let needle = normalize(&q);
    let catalog = get_title_catalog(&session).await;
    let matches: Vec<&(String, String)> = catalog
        .iter()
        .filter(|(title_id, _)| normalize(title_id).contains(&needle))
        .take(8)
        .collect();

    let product_ids: Vec<String> = matches
        .iter()
        .filter(|(_, pid)| !pid.is_empty())
        .map(|(_, pid)| pid.clone())
        .collect();
    let details = resolve_product_details(&product_ids).await;

    let results: Vec<Value> = matches
        .iter()
        .map(|(title_id, pid)| {
            let det = details.get(pid);
            json!({
                "titleId": title_id,
                "productId": pid,
                "titleName": det.map(|d| d.title.clone()).unwrap_or_else(|| title_id.clone()),
                "posterUrl": det.and_then(|d| d.poster.clone()).unwrap_or_default(),
            })
        })
        .collect();

    json!({ "ok": true, "results": results })
}

#[tauri::command]
pub async fn xcloud_waittime(title_id: String) -> Result<Value, String> {
    let session = read_session().ok_or_else(|| "xStreaming não conectado".to_string())?;
    let title_id = title_id.trim().to_uppercase();
    let wait = fetch_wait_times(&session, &title_id).await;
    Ok(json!({
        "ok": true,
        "titleId": title_id,
        "estimatedWaitSeconds": wait.total,
        "estimatedWaitMinutes": minutes(wait.total),
        "provisioningSeconds": wait.provisioning,
        "allocationSeconds": wait.allocation,
        "timestamp": now_ms(),
    }))
}
