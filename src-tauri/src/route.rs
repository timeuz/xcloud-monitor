//! Real route measurement (traceroute) and hairpinning analysis.
//!
//! Runs the OS tool (`tracert` on Windows, `traceroute`/`tracepath` elsewhere), parses its output in a
//! locale-independent way and derives evidence of an international detour from measured data only:
//! hostname PoP codes and sustained RTT jumps. Nothing here is simulated.

use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::net::Ipv4Addr;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TRACE_TARGET: &str = "191.235.228.36";
const TRACE_TARGET_LABEL: &str = "191.235.228.36 (xCloud Cluster Brasil Sul)";
const MAX_HOPS: &str = "20";
const TRACE_DEADLINE: Duration = Duration::from_secs(45);

/// RTT at which a hop is considered "intercontinental" for a São Paulo destination
/// (SP↔Miami ≈ 110–120 ms, SP↔Atlanta ≈ 130 ms).
const INTERCONTINENTAL_RTT_MS: f64 = 90.0;
/// Minimum RTT increase between two consecutive hops that looks like a submarine cable leg.
const CABLE_JUMP_MS: f64 = 60.0;

/// Unambiguous US PoP codes found in router hostnames (token match, trailing digits ignored).
const US_POP_TOKENS: &[(&str, &str)] = &[
    ("mia", "Miami"),
    ("miami", "Miami"),
    ("atl", "Atlanta"),
    ("atlanta", "Atlanta"),
    ("iad", "Ashburn"),
    ("ashburn", "Ashburn"),
    ("ewr", "Nova York"),
    ("jfk", "Nova York"),
    ("nyc", "Nova York"),
    ("dfw", "Dallas"),
    ("dallas", "Dallas"),
    ("lax", "Los Angeles"),
    ("sjc", "San Jose"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHop {
    pub ttl: u32,
    pub ip: String,
    pub host: String,
    pub rtt_ms: f64,
    pub location: String,
    pub is_anomaly: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteResponse {
    pub target: String,
    pub is_hairpinning: bool,
    pub hop_count: usize,
    pub hops: Vec<RouteHop>,
    pub detected_pop: Option<String>,
    pub summary: String,
    pub evidence: Vec<String>,
    pub reached: bool,
    pub source: String,
    pub measured_at: u64,
    /// First hop: the user's own router.
    pub gateway_ip: Option<String>,
    /// First responding hop after the router: the start of the ISP network.
    pub isp_hop_ip: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedHop {
    pub ttl: u32,
    pub ip: Option<Ipv4Addr>,
    pub name: Option<String>,
    pub rtt_ms: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct Analysis {
    pub is_hairpinning: bool,
    pub detected_pop: Option<String>,
    pub evidence: Vec<String>,
    pub anomaly_ttls: Vec<u32>,
}

fn strip_brackets(tok: &str) -> &str {
    tok.trim_matches(|c| matches!(c, '(' | ')' | '[' | ']' | ',' | ':'))
}

fn parse_rtt(tok: &str) -> Option<f64> {
    let t = tok.trim();
    if let Some(rest) = t.strip_prefix('<') {
        return rest.parse::<f64>().ok().map(|_| 0.5);
    }
    t.parse::<f64>().ok()
}

/// Parses `traceroute` / `tracepath` / `tracert` output. Locale-independent: it keys on the hop
/// number, IPv4 tokens and `ms` values, never on translated labels.
pub fn parse_trace_output(text: &str) -> Vec<ParsedHop> {
    let mut by_ttl: BTreeMap<u32, ParsedHop> = BTreeMap::new();

    for line in text.lines() {
        let mut tokens = line.split_whitespace();
        let Some(first) = tokens.next() else { continue };
        let first = first.trim_end_matches(|c| c == ':' || c == '?');
        let Ok(ttl) = first.parse::<u32>() else { continue };
        if ttl == 0 || ttl > 255 {
            continue;
        }

        let rest: Vec<&str> = tokens.collect();
        let mut ip: Option<Ipv4Addr> = None;
        let mut name: Option<String> = None;
        let mut rtts: Vec<f64> = Vec::new();

        for (i, tok) in rest.iter().enumerate() {
            if ip.is_none() {
                if let Ok(addr) = strip_brackets(tok).parse::<Ipv4Addr>() {
                    ip = Some(addr);
                    let bracketed = tok.starts_with('(') || tok.starts_with('[');
                    if bracketed && i > 0 {
                        let prev = rest[i - 1];
                        if prev != "*" && prev.parse::<Ipv4Addr>().is_err() {
                            name = Some(prev.to_string());
                        }
                    }
                    continue;
                }
            }
            let lower = tok.to_lowercase();
            if let Some(num) = lower.strip_suffix("ms") {
                if !num.is_empty() {
                    if let Some(v) = parse_rtt(num) {
                        rtts.push(v);
                    }
                    continue;
                }
            }
            if lower == "ms" && i > 0 {
                if let Some(v) = parse_rtt(rest[i - 1]) {
                    rtts.push(v);
                }
            }
        }

        let rtt = rtts.into_iter().fold(None, |acc: Option<f64>, v| match acc {
            Some(a) => Some(a.min(v)),
            None => Some(v),
        });

        let entry = by_ttl.entry(ttl).or_insert(ParsedHop { ttl, ip: None, name: None, rtt_ms: None });
        entry.ip = entry.ip.or(ip);
        entry.name = entry.name.take().or(name);
        entry.rtt_ms = match (entry.rtt_ms, rtt) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
    }

    by_ttl.into_values().collect()
}

fn is_private_or_local(ip: &Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local()
}

fn is_cgnat(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}

fn us_pop_in_hostname(host: &str) -> Option<&'static str> {
    host.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(|t| t.trim_end_matches(|c: char| c.is_ascii_digit()))
        .find_map(|t| US_POP_TOKENS.iter().find(|(code, _)| *code == t).map(|(_, city)| *city))
}

fn is_microsoft_host(host: &str) -> bool {
    let h = host.to_lowercase();
    h.contains("microsoft") || h.contains("azure") || h.contains("msedge") || h.contains("as8075")
}

/// Decides whether the measured path shows an international detour for a São Paulo destination.
pub fn analyze_route(hops: &[ParsedHop]) -> Analysis {
    let mut out = Analysis::default();

    // Signal 1 (strong): a public hop whose hostname carries a US PoP code.
    for hop in hops {
        let (Some(ip), Some(name)) = (hop.ip.as_ref(), hop.name.as_ref()) else { continue };
        if is_private_or_local(ip) {
            continue;
        }
        if let Some(city) = us_pop_in_hostname(name) {
            out.is_hairpinning = true;
            out.anomaly_ttls.push(hop.ttl);
            if out.detected_pop.is_none() {
                out.detected_pop = Some(format!("{city} (EUA)"));
            }
            out.evidence.push(format!("Salto {} ({name}) está em {city}, EUA.", hop.ttl));
        }
    }

    // Signal 2: a sustained submarine-cable-sized RTT jump. A single slow hop is usually ICMP
    // de-prioritisation on a router, so we require at least two consecutive-or-later hops past the jump.
    let timed: Vec<(u32, f64)> = hops.iter().filter_map(|h| h.rtt_ms.map(|r| (h.ttl, r))).collect();
    for (idx, pair) in timed.windows(2).enumerate() {
        let ((_, r0), (t1, r1)) = (pair[0], pair[1]);
        if r1 - r0 >= CABLE_JUMP_MS && r1 >= INTERCONTINENTAL_RTT_MS {
            let slow_after = timed[idx + 1..].iter().filter(|(_, r)| *r >= INTERCONTINENTAL_RTT_MS).count();
            if slow_after >= 2 {
                out.is_hairpinning = true;
                for (t, r) in &timed[idx + 1..] {
                    if *r >= INTERCONTINENTAL_RTT_MS && !out.anomaly_ttls.contains(t) {
                        out.anomaly_ttls.push(*t);
                    }
                }
                out.evidence.push(format!(
                    "RTT saltou de {r0:.0} ms para {r1:.0} ms no salto {t1} e permaneceu acima de {INTERCONTINENTAL_RTT_MS:.0} ms (compatível com cabo submarino)."
                ));
                break;
            } else {
                out.evidence.push(format!(
                    "Salto {t1} com {r1:.0} ms isolado; sem confirmação nos saltos seguintes (pode ser atraso de ICMP no roteador)."
                ));
            }
        }
    }

    out.anomaly_ttls.sort_unstable();
    out
}

fn location_label(hop: &ParsedHop, analysis: &Analysis) -> String {
    let Some(ip) = hop.ip.as_ref() else { return "Sem resposta".into() };
    if let Some(city) = hop.name.as_deref().and_then(us_pop_in_hostname) {
        return format!("{city} (EUA)");
    }
    if hop.ttl == 1 && is_private_or_local(ip) {
        return "Rede local (roteador)".into();
    }
    if is_cgnat(ip) {
        return "CGNAT da operadora".into();
    }
    if is_private_or_local(ip) {
        return "Rede privada (operadora)".into();
    }
    if hop.name.as_deref().map(is_microsoft_host).unwrap_or(false) {
        return "Rede Microsoft (AS8075)".into();
    }
    if analysis.anomaly_ttls.contains(&hop.ttl) {
        return "Fora do Brasil (inferido por latência)".into();
    }
    "Internet pública".into()
}

pub fn build_response(parsed: Vec<ParsedHop>, source: &str) -> TracerouteResponse {
    let analysis = analyze_route(&parsed);
    let target_ip: Ipv4Addr = TRACE_TARGET.parse().expect("valid target");
    let reached = parsed.iter().any(|h| h.ip == Some(target_ip));
    let hop_count = parsed.iter().filter(|h| h.ip.is_some()).map(|h| h.ttl).max().unwrap_or(0) as usize;

    let hops: Vec<RouteHop> = parsed
        .iter()
        .filter(|h| h.ip.is_some() && h.rtt_ms.is_some())
        .map(|h| {
            let ip = h.ip.expect("filtered");
            RouteHop {
                ttl: h.ttl,
                ip: ip.to_string(),
                host: h.name.clone().unwrap_or_else(|| ip.to_string()),
                rtt_ms: h.rtt_ms.unwrap_or(0.0),
                location: location_label(h, &analysis),
                is_anomaly: analysis.anomaly_ttls.contains(&h.ttl),
            }
        })
        .collect();

    let summary = if analysis.is_hairpinning {
        match &analysis.detected_pop {
            Some(pop) => format!("DESVIO INTERNACIONAL DETECTADO: o tráfego passa por {pop} antes de chegar a São Paulo."),
            None => "DESVIO INTERNACIONAL PROVÁVEL: a latência indica saída do Brasil antes de chegar a São Paulo.".into(),
        }
    } else {
        let tail = if reached { "" } else { " O destino não responde a ICMP; o trecho final não foi medido." };
        format!("Nenhum sinal de desvio internacional em {hop_count} saltos medidos.{tail}")
    };

    let gateway_ip = parsed.iter().find_map(|h| h.ip).map(|ip| ip.to_string());
    let isp_hop_ip = gateway_ip.as_ref().and_then(|gw| {
        parsed.iter().filter_map(|h| h.ip).map(|ip| ip.to_string()).find(|ip| ip != gw)
    });

    let measured_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);

    TracerouteResponse {
        target: TRACE_TARGET_LABEL.into(),
        is_hairpinning: analysis.is_hairpinning,
        hop_count,
        hops,
        detected_pop: analysis.detected_pop,
        summary,
        evidence: analysis.evidence,
        reached,
        source: source.into(),
        measured_at,
        gateway_ip,
        isp_hop_ip,
    }
}

enum RunError {
    NotFound,
    Failed(String),
}

fn run_with_deadline(program: &str, args: &[&str]) -> Result<String, RunError> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            RunError::NotFound
        } else {
            RunError::Failed(e.to_string())
        }
    })?;
    let mut stdout = child.stdout.take().ok_or_else(|| RunError::Failed("stdout indisponível".into()))?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > TRACE_DEADLINE => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(RunError::Failed(e.to_string())),
        }
    }
    let bytes = reader.join().unwrap_or_default();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn tools() -> Vec<(&'static str, Vec<&'static str>)> {
    #[cfg(target_os = "windows")]
    {
        vec![("tracert", vec!["-h", MAX_HOPS, "-w", "800", TRACE_TARGET])]
    }
    #[cfg(target_os = "macos")]
    {
        vec![("traceroute", vec!["-m", MAX_HOPS, "-w", "1", "-q", "1", TRACE_TARGET])]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        vec![
            ("traceroute", vec!["-m", MAX_HOPS, "-w", "1", "-q", "1", TRACE_TARGET]),
            ("tracepath", vec!["-n", "-m", MAX_HOPS, TRACE_TARGET]),
        ]
    }
}

struct RunningGuard;
static RUNNING: AtomicBool = AtomicBool::new(false);

impl RunningGuard {
    fn acquire() -> Option<RunningGuard> {
        RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| RunningGuard)
    }
}
impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

pub fn measure_route() -> Result<TracerouteResponse, String> {
    let _guard = RunningGuard::acquire().ok_or_else(|| "Medição de rota já em andamento.".to_string())?;

    let mut tried: Vec<&str> = Vec::new();
    for (program, args) in tools() {
        match run_with_deadline(program, &args) {
            Ok(text) => {
                let parsed = parse_trace_output(&text);
                if parsed.iter().any(|h| h.ip.is_some()) {
                    return Ok(build_response(parsed, program));
                }
                tried.push(program);
            }
            Err(RunError::NotFound) => tried.push(program),
            Err(RunError::Failed(e)) => return Err(format!("Falha ao executar {program}: {e}")),
        }
    }
    Err(format!(
        "Não foi possível medir a rota (ferramentas tentadas: {}). Instale `traceroute` ou verifique permissões de rede.",
        tried.join(", ")
    ))
}

/// Route result plus whether it was measured just now (so the caller knows to persist it once).
pub struct CachedRoute {
    pub report: TracerouteResponse,
    pub fresh: bool,
}

const ROUTE_CACHE_AGE: Duration = Duration::from_secs(240);
const BUSY_WAIT: Duration = Duration::from_secs(60);
static LAST_ROUTE: Mutex<Option<(Instant, TracerouteResponse)>> = Mutex::new(None);

fn cached_route(max_age: Option<Duration>) -> Option<TracerouteResponse> {
    let guard = LAST_ROUTE.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .as_ref()
        .filter(|(at, _)| max_age.map(|m| at.elapsed() < m).unwrap_or(true))
        .map(|(_, r)| r.clone())
}

/// (gateway, first ISP hop) of the last measured route, if any. Used to probe the path segments.
pub fn path_probe_targets() -> Option<(String, Option<String>)> {
    cached_route(None).and_then(|r| r.gateway_ip.map(|gw| (gw, r.isp_hop_ip)))
}

/// Returns a recent measurement when there is one; otherwise measures. If another measurement
/// is already running, waits for it instead of failing.
pub fn measure_route_cached() -> Result<CachedRoute, String> {
    if let Some(report) = cached_route(Some(ROUTE_CACHE_AGE)) {
        return Ok(CachedRoute { report, fresh: false });
    }

    let waited = Instant::now();
    while RUNNING.load(Ordering::SeqCst) && waited.elapsed() < BUSY_WAIT {
        std::thread::sleep(Duration::from_millis(200));
    }
    if let Some(report) = cached_route(Some(ROUTE_CACHE_AGE)) {
        return Ok(CachedRoute { report, fresh: false });
    }

    match measure_route() {
        Ok(report) => {
            *LAST_ROUTE.lock().unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), report.clone()));
            Ok(CachedRoute { report, fresh: true })
        }
        // On failure keep showing the last known route rather than nothing.
        Err(e) => cached_route(None)
            .map(|report| CachedRoute { report, fresh: false })
            .ok_or(e),
    }
}

#[tauri::command]
pub async fn run_traceroute(
    history: tauri::State<'_, crate::history::History>,
) -> Result<TracerouteResponse, String> {
    let result = tauri::async_runtime::spawn_blocking(measure_route_cached)
        .await
        .map_err(|e| e.to_string())??;
    if result.fresh && history.is_enabled() {
        if let Err(e) = history.record_route(crate::history::now_secs(), &result.report) {
            log::warn!("history: failed to record route: {e}");
        }
    }
    Ok(result.report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX_TRACEROUTE: &str = "traceroute to 191.235.228.36 (191.235.228.36), 20 hops max, 60 byte packets
 1  _gateway (192.168.1.1)  1.234 ms
 2  100.64.0.1 (100.64.0.1)  4.5 ms
 3  *
 4  ix-sp.operadora.net.br (187.16.218.144)  9.8 ms
 5  ae-1.mia12.carrier.net (4.69.1.1)  118.4 ms
 6  ae-2.atl1.carrier.net (4.69.1.2)  131.0 ms
 7  191.235.228.36 (191.235.228.36)  134.7 ms";

    const TRACEPATH: &str = " 1?: [LOCALHOST]                      pmtu 1500
 1:  192.168.0.1                                           0.512ms
 1:  192.168.0.1                                           0.401ms
 2:  no reply
 3:  187.16.218.144                                       11.220ms asymm  2
     Resume: pmtu 1500";

    const WINDOWS_PT: &str = "Rastreando a rota para host [191.235.228.36]
com no m\u{fffd}ximo 20 saltos:

  1    <1 ms    <1 ms    <1 ms  192.168.0.1
  2     5 ms     4 ms     5 ms  100.64.0.1
  3     *        *        *     Esgotado o tempo limite do pedido.
  4    11 ms    10 ms    12 ms  as8075.ix.br [187.16.218.144]
  5    36 ms    35 ms    36 ms  191.235.228.36

Rastreamento conclu\u{fffd}do.";

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn parses_linux_traceroute() {
        let hops = parse_trace_output(LINUX_TRACEROUTE);
        assert_eq!(hops.len(), 7);
        assert_eq!(hops[0].ip, Some(ip("192.168.1.1")));
        assert_eq!(hops[0].name.as_deref(), Some("_gateway"));
        assert_eq!(hops[0].rtt_ms, Some(1.234));
        assert_eq!(hops[2].ip, None);
        assert_eq!(hops[4].name.as_deref(), Some("ae-1.mia12.carrier.net"));
    }

    #[test]
    fn parses_tracepath_and_merges_duplicate_ttls() {
        let hops = parse_trace_output(TRACEPATH);
        assert_eq!(hops[0].ttl, 1);
        assert_eq!(hops[0].ip, Some(ip("192.168.0.1")));
        assert_eq!(hops[0].rtt_ms, Some(0.401));
        assert_eq!(hops[1].ip, None);
        assert_eq!(hops[2].rtt_ms, Some(11.22));
    }

    #[test]
    fn parses_windows_in_any_locale() {
        let hops = parse_trace_output(WINDOWS_PT);
        assert_eq!(hops.len(), 5);
        assert_eq!(hops[0].rtt_ms, Some(0.5));
        assert_eq!(hops[2].ip, None);
        assert_eq!(hops[3].name.as_deref(), Some("as8075.ix.br"));
        assert_eq!(hops[3].ip, Some(ip("187.16.218.144")));
        assert_eq!(hops[4].rtt_ms, Some(35.0));
    }

    #[test]
    fn detects_hairpin_from_hostname_and_rtt() {
        let resp = build_response(parse_trace_output(LINUX_TRACEROUTE), "traceroute");
        assert!(resp.is_hairpinning);
        assert_eq!(resp.detected_pop.as_deref(), Some("Miami (EUA)"));
        assert!(resp.reached);
        assert!(resp.hops.iter().any(|h| h.ttl == 5 && h.is_anomaly && h.location == "Miami (EUA)"));
        assert!(!resp.hops.iter().find(|h| h.ttl == 1).unwrap().is_anomaly);
    }

    #[test]
    fn detects_hairpin_from_sustained_rtt_jump_without_names() {
        let text = " 1  192.168.1.1  1 ms\n 2  10.1.1.1  5 ms\n 3  200.1.1.1  12 ms\n 4  4.4.4.4  120 ms\n 5  5.5.5.5  125 ms\n";
        let a = analyze_route(&parse_trace_output(text));
        assert!(a.is_hairpinning);
        assert_eq!(a.anomaly_ttls, vec![4, 5]);
        assert!(a.detected_pop.is_none());
    }

    #[test]
    fn isolated_slow_hop_is_not_hairpin() {
        let text = " 1  192.168.1.1  1 ms\n 2  10.1.1.1  5 ms\n 3  200.1.1.1  120 ms\n 4  4.4.4.4  14 ms\n";
        let a = analyze_route(&parse_trace_output(text));
        assert!(!a.is_hairpinning);
        assert!(!a.evidence.is_empty());
    }

    #[test]
    fn national_route_is_clean_and_labelled() {
        let resp = build_response(parse_trace_output(WINDOWS_PT), "tracert");
        assert!(!resp.is_hairpinning);
        assert!(resp.reached);
        assert_eq!(resp.hop_count, 5);
        assert_eq!(resp.hops.len(), 4);
        assert_eq!(resp.hops[0].location, "Rede local (roteador)");
        assert_eq!(resp.hops[1].location, "CGNAT da operadora");
        assert_eq!(resp.hops[2].location, "Rede Microsoft (AS8075)");
    }

    #[test]
    fn identifies_gateway_and_first_isp_hop() {
        // tracepath often repeats the router as hop 2; the ISP hop is the first *different* address
        let text = " 1:  192.168.1.1  0.5ms\n 2:  192.168.1.1  0.6ms\n 3:  172.16.112.220  1.5ms\n 4:  200.1.1.1  9ms\n";
        let resp = build_response(parse_trace_output(text), "tracepath");
        assert_eq!(resp.gateway_ip.as_deref(), Some("192.168.1.1"));
        assert_eq!(resp.isp_hop_ip.as_deref(), Some("172.16.112.220"));
    }

    #[test]
    fn us_codes_need_exact_tokens() {
        assert_eq!(us_pop_in_hostname("ae-1.atl2.example.net"), Some("Atlanta"));
        assert_eq!(us_pop_in_hostname("atlantic.example.net"), None);
        assert_eq!(us_pop_in_hostname("miami-gw.example.net"), Some("Miami"));
    }

    /// Needs network and a traceroute tool: `cargo test live_measure_route -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_measure_route() {
        let resp = measure_route().expect("route measurement");
        println!("{}", serde_json::to_string_pretty(&resp).unwrap());
        assert!(!resp.hops.is_empty());
    }
}
