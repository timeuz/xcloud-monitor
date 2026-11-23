//! Bufferbloat test: latency to the xCloud entry point while the line is genuinely saturated.
//!
//! Three phases measured with TCP-connect RTT (and ICMP to the user's router when known):
//! idle, download load and upload load. Load comes from Cloudflare's public speed-test endpoints,
//! so running it uses data (capped) and contacts Cloudflare; the UI asks for confirmation first.
//! While it runs, the background history sampler pauses so the self-inflicted load is never
//! mistaken for a network problem.

use crate::network::{probe_icmp, probe_tcp};
use crate::route;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TARGET_HOST: &str = "191.235.228.36";
const TARGET_PORT: u16 = 443;
const DOWN_URL: &str = "https://speed.cloudflare.com/__down?bytes=25000000";
const UP_URL: &str = "https://speed.cloudflare.com/__up";
const WORKERS: usize = 4;
const IDLE_SECS: u64 = 5;
const LOAD_SECS: u64 = 8;
const COOLDOWN_SECS: u64 = 2;
const MAX_DOWN_BYTES: u64 = 250_000_000;
const MAX_UP_BYTES: u64 = 80_000_000;
const UP_CHUNK: usize = 2_000_000;
const TCP_SAMPLE_EVERY: Duration = Duration::from_millis(250);
const GATEWAY_SAMPLE_EVERY: Duration = Duration::from_millis(500);
const MIN_SAMPLES: usize = 8;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static LAST_END: AtomicU64 = AtomicU64::new(0);

/// True while a test runs and for a few seconds after (queues need time to drain).
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst) || crate::history::now_secs() as u64 - LAST_END.load(Ordering::SeqCst) < 10
}

struct ActiveGuard;
impl ActiveGuard {
    fn acquire() -> Option<ActiveGuard> {
        ACTIVE.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| ActiveGuard)
    }
}
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        LAST_END.store(crate::history::now_secs() as u64, Ordering::SeqCst);
        ACTIVE.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferbloatResponse {
    // kept for the existing UI
    pub idle_rtt: f64,
    pub loaded_rtt: f64,
    pub delta_bufferbloat: f64,
    pub status: String,
    // full result
    pub idle_p95: Option<f64>,
    pub down_mbps: f64,
    pub up_mbps: f64,
    pub delta_down: Option<f64>,
    pub delta_up: Option<f64>,
    pub delta_down_p95: Option<f64>,
    pub delta_up_p95: Option<f64>,
    /// Router latency increase under load: high means the LAN/Wi-Fi itself is saturating.
    pub gateway_delta_down: Option<f64>,
    pub gateway_delta_up: Option<f64>,
    /// A+ / A / B / C / D / F, same bands as the Waveform test
    pub grade: String,
    pub data_used_mb: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PhaseStats {
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub n: usize,
    pub lost: usize,
}

fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil().max(1.0) as usize;
    Some(sorted[rank.min(sorted.len()) - 1])
}

pub fn phase_stats(samples: &[Option<f64>]) -> PhaseStats {
    let mut ok: Vec<f64> = samples.iter().filter_map(|s| *s).collect();
    ok.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    PhaseStats { p50: percentile(&ok, 50.0), p95: percentile(&ok, 95.0), n: samples.len(), lost: samples.len() - ok.len() }
}

/// Waveform-style bands on the worst median latency increase.
pub fn grade(worst_delta_ms: f64) -> &'static str {
    match worst_delta_ms {
        d if d < 5.0 => "A+",
        d if d < 30.0 => "A",
        d if d < 60.0 => "B",
        d if d < 200.0 => "C",
        d if d < 400.0 => "D",
        _ => "F",
    }
}

/// Status labels the existing UI already understands.
fn legacy_status(delta: f64) -> &'static str {
    if delta < 10.0 {
        "EXCELENTE"
    } else if delta <= 35.0 {
        "BOM"
    } else if delta <= 50.0 {
        "ATENÇÃO"
    } else {
        "CRÍTICO_BUFFERBLOAT"
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[derive(Clone, Copy, PartialEq)]
enum Load {
    None,
    Down,
    Up,
}

struct PhaseOutcome {
    target: PhaseStats,
    gateway: PhaseStats,
    bytes: u64,
    secs: f64,
}

fn spawn_sampler<F>(
    stop: Arc<AtomicBool>,
    every: Duration,
    probe: F,
) -> tauri::async_runtime::JoinHandle<Vec<Option<f64>>>
where
    F: Fn() -> Option<f64> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        while !stop.load(Ordering::SeqCst) {
            out.push(probe());
            std::thread::sleep(every);
        }
        out
    })
}

async fn download_worker(client: reqwest::Client, deadline: Instant, bytes: Arc<AtomicU64>) {
    let mut failures = 0;
    while Instant::now() < deadline && bytes.load(Ordering::Relaxed) < MAX_DOWN_BYTES && failures < 3 {
        let Ok(mut resp) = client.get(DOWN_URL).send().await else {
            failures += 1;
            continue;
        };
        if !resp.status().is_success() {
            failures += 1;
            continue;
        }
        while Instant::now() < deadline && bytes.load(Ordering::Relaxed) < MAX_DOWN_BYTES {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                }
                _ => break,
            }
        }
    }
}

async fn upload_worker(client: reqwest::Client, deadline: Instant, bytes: Arc<AtomicU64>) {
    let payload = vec![0u8; UP_CHUNK];
    let mut failures = 0;
    while Instant::now() < deadline && bytes.load(Ordering::Relaxed) < MAX_UP_BYTES && failures < 3 {
        match client.post(UP_URL).body(payload.clone()).send().await {
            Ok(r) if r.status().is_success() => {
                bytes.fetch_add(UP_CHUNK as u64, Ordering::Relaxed);
            }
            _ => failures += 1,
        }
    }
}

async fn run_phase(load: Load, secs: u64, gateway: Option<String>, client: &reqwest::Client) -> PhaseOutcome {
    let stop = Arc::new(AtomicBool::new(false));
    let target = spawn_sampler(stop.clone(), TCP_SAMPLE_EVERY, || probe_tcp(TARGET_HOST, TARGET_PORT));
    let gw = gateway.map(|ip| spawn_sampler(stop.clone(), GATEWAY_SAMPLE_EVERY, move || probe_icmp(&ip)));

    let started = Instant::now();
    let deadline = started + Duration::from_secs(secs);
    let bytes = Arc::new(AtomicU64::new(0));

    let workers: Vec<_> = match load {
        Load::None => vec![],
        Load::Down => (0..WORKERS)
            .map(|_| tauri::async_runtime::spawn(download_worker(client.clone(), deadline, bytes.clone())))
            .collect(),
        Load::Up => (0..WORKERS)
            .map(|_| tauri::async_runtime::spawn(upload_worker(client.clone(), deadline, bytes.clone())))
            .collect(),
    };

    tokio::time::sleep(Duration::from_secs(secs)).await;
    for w in workers {
        let _ = w.await;
    }
    let secs = started.elapsed().as_secs_f64();
    stop.store(true, Ordering::SeqCst);

    let target = target.await.map(|s| phase_stats(&s)).unwrap_or_default();
    let gateway = match gw {
        Some(h) => h.await.map(|s| phase_stats(&s)).unwrap_or_default(),
        None => PhaseStats::default(),
    };
    PhaseOutcome { target, gateway, bytes: bytes.load(Ordering::Relaxed), secs }
}

fn mbps(bytes: u64, secs: f64) -> f64 {
    if secs <= 0.0 {
        0.0
    } else {
        round1(bytes as f64 * 8.0 / secs / 1_000_000.0)
    }
}

fn delta(loaded: Option<f64>, idle: Option<f64>) -> Option<f64> {
    Some(round1((loaded? - idle?).max(0.0)))
}

/// Combines the three phases into the response; pure, so it can be unit-tested.
fn assemble(idle: &PhaseOutcome, down: &PhaseOutcome, up: &PhaseOutcome) -> Result<BufferbloatResponse, String> {
    let idle_p50 = idle.target.p50.ok_or_else(|| "Sem resposta do alvo em repouso; teste cancelado.".to_string())?;
    if down.bytes == 0 && up.bytes == 0 {
        return Err("Não foi possível gerar carga (sem acesso à Cloudflare?); teste cancelado.".into());
    }
    for (name, phase) in [("download", down), ("upload", up)] {
        if phase.bytes > 0 && phase.target.n - phase.target.lost < MIN_SAMPLES {
            return Err(format!("Poucas respostas durante o {name}: a linha ficou saturada demais para medir."));
        }
    }

    let delta_down = if down.bytes > 0 { delta(down.target.p50, Some(idle_p50)) } else { None };
    let delta_up = if up.bytes > 0 { delta(up.target.p50, Some(idle_p50)) } else { None };
    let worst = [delta_down, delta_up].into_iter().flatten().fold(0.0_f64, f64::max);

    Ok(BufferbloatResponse {
        idle_rtt: round1(idle_p50),
        loaded_rtt: round1(idle_p50 + worst),
        delta_bufferbloat: worst,
        status: legacy_status(worst).into(),
        idle_p95: idle.target.p95.map(round1),
        down_mbps: mbps(down.bytes, down.secs),
        up_mbps: mbps(up.bytes, up.secs),
        delta_down,
        delta_up,
        delta_down_p95: if down.bytes > 0 { delta(down.target.p95, idle.target.p95) } else { None },
        delta_up_p95: if up.bytes > 0 { delta(up.target.p95, idle.target.p95) } else { None },
        gateway_delta_down: if down.bytes > 0 { delta(down.gateway.p50, idle.gateway.p50) } else { None },
        gateway_delta_up: if up.bytes > 0 { delta(up.gateway.p50, idle.gateway.p50) } else { None },
        grade: grade(worst).into(),
        data_used_mb: round1((down.bytes + up.bytes) as f64 / 1_000_000.0),
    })
}

pub async fn run() -> Result<BufferbloatResponse, String> {
    let _guard = ActiveGuard::acquire().ok_or_else(|| "Já existe um teste de bufferbloat em andamento.".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let gateway = route::path_probe_targets().map(|(gw, _)| gw);

    let idle = run_phase(Load::None, IDLE_SECS, gateway.clone(), &client).await;
    let down = run_phase(Load::Down, LOAD_SECS, gateway.clone(), &client).await;
    tokio::time::sleep(Duration::from_secs(COOLDOWN_SECS)).await;
    let up = run_phase(Load::Up, LOAD_SECS, gateway, &client).await;
    assemble(&idle, &down, &up)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(p50: Option<f64>, p95: Option<f64>, n: usize, lost: usize, bytes: u64) -> PhaseOutcome {
        PhaseOutcome {
            target: PhaseStats { p50, p95, n, lost },
            gateway: PhaseStats { p50: Some(0.5), p95: Some(0.8), n, lost: 0 },
            bytes,
            secs: 8.0,
        }
    }

    #[test]
    fn grade_bands_match_the_published_scale() {
        assert_eq!(grade(0.0), "A+");
        assert_eq!(grade(4.9), "A+");
        assert_eq!(grade(5.0), "A");
        assert_eq!(grade(45.0), "B");
        assert_eq!(grade(150.0), "C");
        assert_eq!(grade(399.0), "D");
        assert_eq!(grade(900.0), "F");
    }

    #[test]
    fn phase_stats_counts_loss_and_percentiles() {
        let s = phase_stats(&[Some(10.0), Some(20.0), None, Some(30.0), Some(40.0)]);
        assert_eq!((s.n, s.lost), (5, 1));
        assert_eq!(s.p50, Some(20.0));
        assert_eq!(s.p95, Some(40.0));
        assert_eq!(phase_stats(&[None, None]).p50, None);
    }

    #[test]
    fn assemble_computes_deltas_throughput_and_worst_case_grade() {
        let idle = outcome(Some(40.0), Some(44.0), 20, 0, 0);
        let down = outcome(Some(48.0), Some(70.0), 30, 0, 100_000_000); // 100 MB in 8 s = 100 Mbps
        let up = outcome(Some(130.0), Some(220.0), 30, 1, 20_000_000);
        let r = assemble(&idle, &down, &up).unwrap();
        assert_eq!(r.delta_down, Some(8.0));
        assert_eq!(r.delta_up, Some(90.0));
        assert_eq!(r.delta_bufferbloat, 90.0);
        assert_eq!(r.grade, "C");
        assert_eq!(r.status, "CRÍTICO_BUFFERBLOAT");
        assert_eq!(r.down_mbps, 100.0);
        assert_eq!(r.up_mbps, 20.0);
        assert_eq!(r.idle_rtt, 40.0);
        assert_eq!(r.loaded_rtt, 130.0);
        assert_eq!(r.data_used_mb, 120.0);
        assert_eq!(r.gateway_delta_down, Some(0.0));
    }

    #[test]
    fn assemble_refuses_to_invent_results() {
        let idle = outcome(Some(40.0), Some(44.0), 20, 0, 0);
        let none = outcome(None, None, 0, 0, 0);
        // no idle answer
        assert!(assemble(&outcome(None, None, 5, 5, 0), &none, &none).is_err());
        // no load could be generated
        assert!(assemble(&idle, &outcome(Some(40.0), Some(40.0), 30, 0, 0), &outcome(Some(40.0), Some(40.0), 30, 0, 0)).is_err());
        // load generated but the line was too saturated to get any answer
        let choked = outcome(None, None, 30, 30, 50_000_000);
        assert!(assemble(&idle, &choked, &none).is_err());
    }

    #[test]
    fn a_missing_direction_is_reported_as_none_not_zero() {
        let idle = outcome(Some(40.0), Some(44.0), 20, 0, 0);
        let down = outcome(Some(42.0), Some(50.0), 30, 0, 50_000_000);
        let up = outcome(Some(40.0), Some(40.0), 30, 0, 0); // upload produced no data
        let r = assemble(&idle, &down, &up).unwrap();
        assert_eq!(r.delta_up, None);
        assert_eq!(r.delta_down, Some(2.0));
        assert_eq!(r.grade, "A+");
    }

    /// Uses ~300 MB and needs internet: `cargo test live_bufferbloat -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_bufferbloat() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let r = rt.block_on(run());
        println!("{r:#?}");
        assert!(r.is_ok());
    }
}
