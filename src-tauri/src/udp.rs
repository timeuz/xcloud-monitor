//! UDP path test: a steady stream of STUN Binding Requests, which public STUN servers answer.
//!
//! Why: ICMP can be filtered or de-prioritised, and game streaming is UDP. This sends 50 small packets per
//! second for 10 s to each server and measures round trip, loss, jitter and the longest run of consecutive
//! losses (burst loss is what visibly breaks a video stream). It is an honest UDP probe at a low packet
//! rate, NOT a video-rate throughput test: it says nothing about bandwidth.

use serde::Serialize;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

pub const PACKETS_PER_SECOND: u64 = 50;
pub const DURATION_SECS: u64 = 10;
const GRACE: Duration = Duration::from_millis(1500);
const MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];

pub struct StunTarget {
    pub id: &'static str,
    pub label: &'static str,
    pub host: &'static str,
    pub port: u16,
}

pub const STUN_TARGETS: &[StunTarget] = &[
    StunTarget { id: "stun_cloudflare", label: "Cloudflare", host: "stun.cloudflare.com", port: 3478 },
    StunTarget { id: "stun_google", label: "Google", host: "stun.l.google.com", port: 19302 },
    StunTarget { id: "stun_microsoft", label: "Microsoft (Teams/Azure)", host: "worldaz.tr.teams.microsoft.com", port: 3478 },
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpStats {
    pub sent: usize,
    pub received: usize,
    pub loss_pct: f64,
    pub rtt_p50: Option<f64>,
    pub rtt_p95: Option<f64>,
    pub rtt_max: Option<f64>,
    pub jitter: Option<f64>,
    /// longest run of consecutive unanswered packets
    pub max_burst_loss: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpTargetResult {
    pub id: String,
    pub label: String,
    /// resolved address, or why the target could not be tested
    pub addr: String,
    pub error: Option<String>,
    #[serde(flatten)]
    pub stats: UdpStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpTestResponse {
    pub measured_at: i64,
    pub packets_per_second: u64,
    pub duration_secs: u64,
    pub results: Vec<UdpTargetResult>,
}

/// STUN Binding Request (RFC 5389): type 0x0001, no attributes, cookie, 12-byte transaction id.
/// The id carries the packet index so a reply is matched without a lookup table.
pub fn build_request(index: u32, salt: [u8; 8]) -> [u8; 20] {
    let mut p = [0u8; 20];
    p[0] = 0x00;
    p[1] = 0x01;
    p[4..8].copy_from_slice(&MAGIC_COOKIE);
    p[8..12].copy_from_slice(&index.to_be_bytes());
    p[12..20].copy_from_slice(&salt);
    p
}

/// Index of the request a Binding response answers, if it is one for this run.
pub fn parse_response(buf: &[u8], salt: [u8; 8]) -> Option<u32> {
    if buf.len() < 20 || buf[4..8] != MAGIC_COOKIE || buf[12..20] != salt {
        return None;
    }
    // 0x0101 success, 0x0111 error: both prove the path works for a round trip
    if !(buf[0] == 0x01 && (buf[1] == 0x01 || buf[1] == 0x11)) {
        return None;
    }
    Some(u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]))
}

fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil().max(1.0) as usize;
    Some(sorted[rank.min(sorted.len()) - 1])
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// `rtts[i]` is the round trip of packet `i` in ms, `None` if it never came back.
pub fn summarize_udp(rtts: &[Option<f64>]) -> UdpStats {
    let ok: Vec<f64> = rtts.iter().filter_map(|r| *r).collect();
    let mut sorted = ok.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let mut burst = 0usize;
    let mut max_burst = 0usize;
    for r in rtts {
        if r.is_none() {
            burst += 1;
            max_burst = max_burst.max(burst);
        } else {
            burst = 0;
        }
    }
    let jitter = if ok.len() >= 2 {
        Some(round2(ok.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (ok.len() - 1) as f64))
    } else {
        None
    };
    UdpStats {
        sent: rtts.len(),
        received: ok.len(),
        loss_pct: if rtts.is_empty() { 0.0 } else { round2((rtts.len() - ok.len()) as f64 / rtts.len() as f64 * 100.0) },
        rtt_p50: percentile(&sorted, 50.0).map(round2),
        rtt_p95: percentile(&sorted, 95.0).map(round2),
        rtt_max: sorted.last().copied().map(round2),
        jitter,
        max_burst_loss: max_burst,
    }
}

/// Sends `packets` requests at `interval` and collects the round trips.
pub fn run_stream(addr: SocketAddr, packets: usize, interval: Duration) -> Result<UdpStats, String> {
    let bind = if addr.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
    let socket = UdpSocket::bind(bind).map_err(|e| e.to_string())?;
    socket.connect(addr).map_err(|e| e.to_string())?;

    // per-run salt: replies from an earlier run or a stray sender never match
    let salt: [u8; 8] = {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        (t as u64 ^ 0x9E37_79B9_7F4A_7C15).to_be_bytes()
    };

    let mut sent_at: Vec<Option<Instant>> = vec![None; packets];
    let mut rtts: Vec<Option<f64>> = vec![None; packets];
    let mut buf = [0u8; 1500];
    let start = Instant::now();

    let handle_reply = |buf: &[u8], now: Instant, sent_at: &[Option<Instant>], rtts: &mut [Option<f64>]| {
        if let Some(i) = parse_response(buf, salt) {
            let i = i as usize;
            if i < packets && rtts[i].is_none() {
                if let Some(t0) = sent_at[i] {
                    rtts[i] = Some(now.duration_since(t0).as_secs_f64() * 1000.0);
                }
            }
        }
    };

    for i in 0..packets {
        let due = start + interval * i as u32;
        let now = Instant::now();
        if due > now {
            // wait for the slot while collecting replies
            while Instant::now() < due {
                let left = due.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
                socket.set_read_timeout(Some(left)).map_err(|e| e.to_string())?;
                match socket.recv(&mut buf) {
                    Ok(n) => handle_reply(&buf[..n], Instant::now(), &sent_at, &mut rtts),
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                    Err(_) => {} // e.g. ICMP unreachable surfaced as an error: count it as loss
                }
            }
        }
        sent_at[i] = Some(Instant::now());
        socket.send(&build_request(i as u32, salt)).map_err(|e| format!("falha ao enviar: {e}"))?;
    }

    // stragglers
    let grace_end = Instant::now() + GRACE;
    while Instant::now() < grace_end {
        let left = grace_end.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
        socket.set_read_timeout(Some(left)).map_err(|e| e.to_string())?;
        match socket.recv(&mut buf) {
            Ok(n) => handle_reply(&buf[..n], Instant::now(), &sent_at, &mut rtts),
            Err(_) => {}
        }
    }
    Ok(summarize_udp(&rtts))
}

fn resolve(t: &StunTarget) -> Result<SocketAddr, String> {
    (t.host, t.port)
        .to_socket_addrs()
        .map_err(|e| format!("não resolveu {}: {e}", t.host))?
        .find(|a| a.is_ipv4())
        .ok_or_else(|| format!("{} não tem endereço IPv4", t.host))
}

/// Runs the stream against every STUN target, one after the other.
pub fn run_all(now: i64) -> UdpTestResponse {
    let packets = (PACKETS_PER_SECOND * DURATION_SECS) as usize;
    let interval = Duration::from_micros(1_000_000 / PACKETS_PER_SECOND);
    let results = STUN_TARGETS
        .iter()
        .map(|t| {
            let outcome = resolve(t).and_then(|addr| run_stream(addr, packets, interval).map(|s| (addr, s)));
            match outcome {
                Ok((addr, stats)) => UdpTargetResult { id: t.id.into(), label: t.label.into(), addr: addr.to_string(), error: None, stats },
                Err(e) => UdpTargetResult {
                    id: t.id.into(),
                    label: t.label.into(),
                    addr: format!("{}:{}", t.host, t.port),
                    error: Some(e),
                    stats: summarize_udp(&[]),
                },
            }
        })
        .collect();
    UdpTestResponse { measured_at: now, packets_per_second: PACKETS_PER_SECOND, duration_secs: DURATION_SECS, results }
}

#[tauri::command]
pub async fn run_udp_test(history: tauri::State<'_, crate::history::History>) -> Result<UdpTestResponse, String> {
    let response = tauri::async_runtime::spawn_blocking(|| run_all(crate::history::now_secs()))
        .await
        .map_err(|e| e.to_string())?;
    if history.is_enabled() {
        for r in response.results.iter().filter(|r| r.error.is_none()) {
            if let Err(e) = history.record_udp(response.measured_at, r) {
                log::warn!("history: failed to record udp run: {e}");
            }
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    const SALT: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

    #[test]
    fn request_has_the_stun_shape_and_round_trips_its_index() {
        let req = build_request(7, SALT);
        assert_eq!(&req[0..2], &[0x00, 0x01]);
        assert_eq!(&req[4..8], &MAGIC_COOKIE);
        let mut resp = req;
        resp[0] = 0x01;
        resp[1] = 0x01; // success response
        assert_eq!(parse_response(&resp, SALT), Some(7));
        resp[1] = 0x11; // error response still proves a round trip
        assert_eq!(parse_response(&resp, SALT), Some(7));
    }

    #[test]
    fn foreign_or_malformed_replies_are_ignored() {
        let mut resp = build_request(3, SALT);
        resp[0] = 0x01;
        resp[1] = 0x01;
        assert_eq!(parse_response(&resp, [9; 8]), None, "other run's salt");
        assert_eq!(parse_response(&resp[..19], SALT), None, "truncated");
        let mut bad_cookie = resp;
        bad_cookie[4] = 0;
        assert_eq!(parse_response(&bad_cookie, SALT), None);
        let request_echo = build_request(3, SALT); // type 0x0001 is a request, not a response
        assert_eq!(parse_response(&request_echo, SALT), None);
    }

    #[test]
    fn summary_counts_loss_percentiles_jitter_and_the_longest_burst() {
        let rtts = vec![Some(10.0), Some(12.0), None, None, None, Some(11.0), None, Some(40.0)];
        let s = summarize_udp(&rtts);
        assert_eq!((s.sent, s.received), (8, 4));
        assert_eq!(s.loss_pct, 50.0);
        assert_eq!(s.max_burst_loss, 3);
        assert_eq!(s.rtt_p50, Some(11.0));
        assert_eq!(s.rtt_max, Some(40.0));
        // |12-10|, |11-12|, |40-11| over 3 gaps
        assert_eq!(s.jitter, Some(10.67));
        let empty = summarize_udp(&[]);
        assert_eq!((empty.sent, empty.loss_pct, empty.rtt_p50), (0, 0.0, None));
        assert_eq!(summarize_udp(&[None, None]).loss_pct, 100.0);
    }

    /// A local STUN-like responder that drops every `drop_every`-th request.
    fn spawn_responder(drop_every: usize) -> (SocketAddr, Arc<AtomicBool>) {
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        sock.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        let addr = sock.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1500];
            let mut n = 0usize;
            while !flag.load(Ordering::SeqCst) {
                if let Ok((len, from)) = sock.recv_from(&mut buf) {
                    n += 1;
                    if drop_every > 0 && n % drop_every == 0 {
                        continue;
                    }
                    let mut reply = buf[..len].to_vec();
                    reply[0] = 0x01;
                    reply[1] = 0x01;
                    let _ = sock.send_to(&reply, from);
                }
            }
        });
        (addr, stop)
    }

    #[test]
    fn stream_against_a_local_responder_measures_loss_and_rtt() {
        let (addr, stop) = spawn_responder(10); // drops 10%
        let s = run_stream(addr, 100, Duration::from_millis(5)).unwrap();
        stop.store(true, Ordering::SeqCst);
        assert_eq!(s.sent, 100);
        assert!((s.loss_pct - 10.0).abs() <= 2.0, "loss {}", s.loss_pct);
        assert_eq!(s.max_burst_loss, 1, "evenly spaced drops are never a burst");
        assert!(s.rtt_p50.unwrap() < 50.0, "loopback RTT must be tiny: {:?}", s.rtt_p50);
    }

    #[test]
    fn a_silent_server_is_one_hundred_percent_loss_not_an_error() {
        let silent = UdpSocket::bind("127.0.0.1:0").unwrap();
        let addr = silent.local_addr().unwrap();
        let s = run_stream(addr, 20, Duration::from_millis(5)).unwrap();
        assert_eq!((s.sent, s.received, s.loss_pct, s.max_burst_loss), (20, 0, 100.0, 20));
        assert_eq!(s.rtt_p50, None);
    }

    /// Needs internet: `cargo test live_udp -- --ignored --nocapture` (about 35 s).
    #[test]
    #[ignore]
    fn live_udp() {
        let r = run_all(0);
        println!("{}", serde_json::to_string_pretty(&r).unwrap());
        assert!(r.results.iter().any(|t| t.error.is_none() && t.stats.received > 0));
    }
}
