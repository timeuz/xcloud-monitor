//! Measures the game session's real media server.
//!
//! The server changes every match and is not visible to an unprivileged app (WebRTC uses unconnected UDP
//! sockets), so the user supplies its IP (the helper script `scripts/find-session-peer.sh` finds it with a
//! short packet capture). The app then measures it like any other target: ping series, route with the hairpin
//! analysis, and the difference against the xCloud entry point measured at the same time. That is the number
//! that answers "but your ICMP test is not the game": it is the game's own server.

use crate::history::{now_secs, History};
use crate::report::{latency_jumps, HopRow, Jump};
use crate::route::{self, RouteHop};
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::process::Command;

const PING_COUNT: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRun {
    pub ts: i64,
    pub peer_ip: String,
    pub note: Option<String>,
    pub sent: i64,
    pub received: i64,
    pub loss_pct: f64,
    pub rtt_p50: Option<f64>,
    pub rtt_p95: Option<f64>,
    pub jitter: Option<f64>,
    /// xCloud entry point RTT measured by the sampler right before; the difference shows a distant game server
    pub entry_rtt: Option<f64>,
    /// the server never answered ICMP (the route may still be there)
    pub icmp_blocked: bool,
    pub hairpin: bool,
    pub hop_count: i64,
    pub hops: Vec<RouteHop>,
    #[serde(default)]
    pub largest_jump: Option<Jump>,
}

fn to_hop_rows(hops: &[RouteHop]) -> Vec<HopRow> {
    hops.iter()
        .map(|h| HopRow { ttl: h.ttl, ip: h.ip.clone(), host: h.host.clone(), rtt_ms: h.rtt_ms, location: h.location.clone(), is_anomaly: h.is_anomaly })
        .collect()
}

/// First IPv4 address found in free text: "13.104.105.250", "13.104.105.250:1069", tcpdump's
/// "13.104.105.250.1069", or a pasted conntrack line ("dst=13.104.105.250 sport=...").
pub fn find_ipv4(text: &str) -> Option<Ipv4Addr> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter(|piece| piece.matches('.').count() >= 3)
        .find_map(|piece| {
            let parts: Vec<&str> = piece.split('.').collect();
            let octets: Option<Vec<u8>> = parts.iter().take(4).map(|p| p.parse::<u8>().ok()).collect();
            octets.filter(|o| o.len() == 4).map(|o| Ipv4Addr::new(o[0], o[1], o[2], o[3]))
        })
}

/// Only a public unicast IPv4 is a plausible game server; anything else is a typo or the user's own network.
pub fn validate_peer(input: &str) -> Result<Ipv4Addr, String> {
    if input.contains(':') && input.matches(':').count() > 1 && !input.contains('.') {
        return Err("Por enquanto só endereços IPv4: o xCloud usa IPv4.".into());
    }
    let ip = find_ipv4(input).ok_or_else(|| "Não encontrei um endereço IPv4 no texto (exemplo: 13.104.105.250 ou 13.104.105.250:1069).".to_string())?;
    let o = ip.octets();
    let cgnat = o[0] == 100 && (64..=127).contains(&o[1]);
    if ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() || ip.is_documentation() || cgnat || o[0] == 0 || o[0] >= 240 {
        return Err(format!("{ip} não é um endereço público: o servidor do jogo precisa estar na internet, não na sua rede."));
    }
    Ok(ip)
}

/// Round trips of the replies in a `ping` output, any locale: reply lines carry `ttl` and a `time=Nms`-like value.
pub fn parse_ping_replies(text: &str) -> Vec<f64> {
    let mut out = Vec::new();
    for line in text.lines() {
        if !line.to_lowercase().contains("ttl") {
            continue;
        }
        let bytes: Vec<char> = line.chars().collect();
        for (i, c) in bytes.iter().enumerate() {
            if *c != '=' && *c != '<' {
                continue;
            }
            let rest: String = bytes[i + 1..].iter().collect();
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
            if num.is_empty() {
                continue;
            }
            if rest[num.len()..].trim_start().to_lowercase().starts_with("ms") {
                let v = if *c == '<' { 0.5 } else { num.replace(',', ".").parse::<f64>().unwrap_or(f64::NAN) };
                if v.is_finite() {
                    out.push(v);
                }
                break;
            }
        }
    }
    out
}

fn ping_series(ip: Ipv4Addr) -> Vec<f64> {
    let count = PING_COUNT.to_string();
    let host = ip.to_string();
    #[cfg(target_os = "windows")]
    let args: Vec<&str> = vec!["-n", &count, "-w", "1000", &host];
    #[cfg(target_os = "macos")]
    let args: Vec<&str> = vec!["-c", &count, "-W", "1000", &host];
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let args: Vec<&str> = vec!["-c", &count, "-i", "0.2", "-W", "1", &host];

    let mut cmd = Command::new("ping");
    cmd.args(&args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.output() {
        Ok(o) => parse_ping_replies(&String::from_utf8_lossy(&o.stdout)),
        Err(_) => vec![],
    }
}

/// Measures `input` (a pasted address) and stores the result.
pub fn measure_peer(history: &History, input: &str, note: Option<String>) -> Result<SessionRun, String> {
    let ip = validate_peer(input)?;
    let ts = now_secs();
    let entry_rtt = history.latest_rtt("xcloud_gssv_prod", ts - 120);

    let replies = ping_series(ip);
    let mut samples: Vec<Option<f64>> = replies.iter().copied().map(Some).collect();
    samples.resize(PING_COUNT.max(samples.len()), None);
    let stats = crate::history::summarize(&samples);

    // the route is best effort: a failed traceroute must not discard the ping numbers
    let (hairpin, hop_count, hops) = match route::measure_route_to(ip, format!("{ip} (servidor da sessão)")) {
        Ok(r) => (r.is_hairpinning, r.hop_count as i64, r.hops),
        Err(_) => (false, 0, vec![]),
    };
    let largest_jump = latency_jumps(&to_hop_rows(&hops), 5.0).into_iter().next();

    let run = SessionRun {
        ts,
        peer_ip: ip.to_string(),
        note: note.map(|n| n.trim().chars().take(80).collect::<String>()).filter(|n| !n.is_empty()),
        sent: stats.n,
        received: stats.n - stats.n_lost,
        loss_pct: if stats.n > 0 { (stats.n_lost as f64 / stats.n as f64 * 1000.0).round() / 10.0 } else { 0.0 },
        rtt_p50: stats.p50,
        rtt_p95: stats.p95,
        jitter: stats.jitter.map(|v| (v * 100.0).round() / 100.0),
        entry_rtt,
        icmp_blocked: replies.is_empty(),
        hairpin,
        hop_count,
        hops,
        largest_jump,
    };
    if history.is_enabled() {
        history.record_session(&run)?;
    }
    Ok(run)
}

#[tauri::command]
pub async fn measure_session_peer(app: tauri::AppHandle, peer: String, note: Option<String>) -> Result<SessionRun, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || measure_peer(&app.state::<History>(), &peer, note))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn history_session_runs(history: tauri::State<'_, History>, limit: Option<u32>) -> Result<Vec<SessionRun>, String> {
    history.session_runs(limit.unwrap_or(20).clamp(1, 100) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_address_in_every_format_the_user_may_paste() {
        let want = Some(Ipv4Addr::new(13, 104, 105, 250));
        assert_eq!(find_ipv4("13.104.105.250"), want);
        assert_eq!(find_ipv4("  13.104.105.250:1069 "), want);
        assert_eq!(find_ipv4("13.104.105.250.1069"), want, "tcpdump prints ip.port");
        assert_eq!(find_ipv4("udp 17 119 src=192.168.1.19 dst=13.104.105.250 sport=52012"), Some(Ipv4Addr::new(192, 168, 1, 19)), "first one wins");
        assert_eq!(find_ipv4("sem ip aqui 1.2.3"), None);
        assert_eq!(find_ipv4("999.1.1.1"), None);
    }

    #[test]
    fn only_public_unicast_addresses_are_accepted() {
        assert_eq!(validate_peer("13.104.105.250:1069").unwrap(), Ipv4Addr::new(13, 104, 105, 250));
        for bad in ["192.168.1.1", "10.0.0.5", "172.16.112.220", "127.0.0.1", "100.64.0.1", "169.254.1.1", "224.0.0.251", "0.0.0.0", "255.255.255.255", "240.0.0.1", "192.0.2.10"] {
            let e = validate_peer(bad).expect_err(bad);
            assert!(e.contains("não é um endereço público"), "{bad}: {e}");
        }
        assert!(validate_peer("2804:56b0:1aa:1b00::1").unwrap_err().contains("IPv4"));
        assert!(validate_peer("não é ip").unwrap_err().contains("IPv4"));
    }

    #[test]
    fn ping_replies_are_parsed_in_any_locale() {
        let linux = "64 bytes from 1.2.3.4: icmp_seq=1 ttl=57 time=14.5 ms\n64 bytes from 1.2.3.4: icmp_seq=2 ttl=57 time=15.25 ms\nrtt min/avg/max/mdev = 14.5/14.9/15.2/0.3 ms";
        assert_eq!(parse_ping_replies(linux), vec![14.5, 15.25]);
        let win_pt = "Resposta de 1.2.3.4: bytes=32 tempo=18ms TTL=57\nResposta de 1.2.3.4: bytes=32 tempo<1ms TTL=57\nEstat\u{fffd}sticas: M\u{fffd}nimo = 1ms, M\u{fffd}ximo = 18ms, M\u{fffd}dia = 9ms";
        assert_eq!(parse_ping_replies(win_pt), vec![18.0, 0.5]);
        assert_eq!(parse_ping_replies("Request timed out.\nRequest timed out."), Vec::<f64>::new());
        assert_eq!(parse_ping_replies("64 bytes from x: icmp_seq=1 ttl=57 time=1,5 ms"), vec![1.5], "decimal comma");
    }

    #[test]
    fn a_lost_reply_pads_the_series_without_inventing_values() {
        let mut samples: Vec<Option<f64>> = [40.0, 42.0, 41.0].iter().copied().map(Some).collect();
        samples.resize(PING_COUNT, None);
        let s = crate::history::summarize(&samples);
        assert_eq!((s.n, s.n_lost), (20, 17));
        assert_eq!(s.p50, Some(41.0));
    }

    #[test]
    fn measuring_stores_and_lists_the_run_and_refuses_private_peers() {
        let h = History::open_in_memory().unwrap();
        assert!(measure_peer(&h, "192.168.1.1", None).is_err());
        assert!(h.session_runs(10).unwrap().is_empty(), "a refused peer leaves no trace");

        let run = SessionRun {
            ts: 1_000,
            peer_ip: "13.104.105.250".into(),
            note: Some("partida de teste".into()),
            sent: 20,
            received: 20,
            loss_pct: 0.0,
            rtt_p50: Some(45.4),
            rtt_p95: Some(47.0),
            jitter: Some(0.9),
            entry_rtt: Some(41.6),
            icmp_blocked: false,
            hairpin: false,
            hop_count: 12,
            hops: vec![],
            largest_jump: None,
        };
        h.record_session(&run).unwrap();
        let back = h.session_runs(10).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].peer_ip, "13.104.105.250");
        assert_eq!(back[0].entry_rtt, Some(41.6));
        assert_eq!(back[0].note.as_deref(), Some("partida de teste"));
    }

    /// Needs internet and a reachable server: `SESSION_PEER=13.104.105.250 cargo test live_session -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_session() {
        let peer = std::env::var("SESSION_PEER").expect("set SESSION_PEER");
        let h = History::open_in_memory().unwrap();
        let run = measure_peer(&h, &peer, Some("teste".into())).unwrap();
        println!("{}", serde_json::to_string_pretty(&run).unwrap());
        assert_eq!(h.session_runs(5).unwrap().len(), 1);
    }
}
