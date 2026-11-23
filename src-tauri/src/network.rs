use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategicEndpoint {
    pub id: String,
    pub label: String,
    pub host: String,
    pub category: String,
    #[serde(rename = "rttMs")]
    pub rtt_ms: Option<f64>,
    pub online: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomHostResult {
    pub host: String,
    #[serde(rename = "rttMs")]
    pub rtt_ms: Option<f64>,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryProbeResponse {
    pub timestamp: u64,
    pub endpoints: Vec<StrategicEndpoint>,
    #[serde(rename = "spEdgeRtt")]
    pub sp_edge_rtt: Option<f64>,
    #[serde(rename = "azureRtt")]
    pub azure_rtt: Option<f64>,
    #[serde(rename = "usMiamiRtt")]
    pub us_miami_rtt: Option<f64>,
    #[serde(rename = "customHost")]
    pub custom_host: Option<CustomHostResult>,
}

/// Ids measured by older versions and since retired (they never answered, were duplicates of another
/// target, or were not representative). Their stored rows are dropped when the history opens.
pub const RETIRED_TARGETS: &[&str] = &[
    "xcloud_brs_direct",
    "xcloud_gssv_web",
    "ix_sp_v4_1",
    "equinix_sp_v4_1",
    "ix_rj",
    "ix_campinas",
    "ix_fortaleza",
    "us_equinix_miami",
    "us_equinix_atlanta",
    "us_equinix_ashburn",
];

struct TargetDef {
    id: &'static str,
    label: &'static str,
    host: &'static str,
    port: u16,
    category: &'static str,
}

const STRATEGIC_TARGETS: &[TargetDef] = &[
    TargetDef {
        id: "xcloud_gssv_prod",
        label: "xCloud Streaming (GSSV Xbox Live)",
        host: "xgpu.gssv-play-prod.xboxlive.com",
        port: 443,
        category: "azure_brazilsouth",
    },
    TargetDef {
        id: "ix_sp_v4_2",
        label: "IX.br SP: peering Microsoft (AS8075)",
        host: "187.16.218.139",
        port: 443,
        category: "borda_brasil",
    },
    TargetDef {
        id: "sp_google_dns",
        label: "São Paulo: Google (8.8.8.8)",
        host: "8.8.8.8",
        port: 443,
        category: "borda_brasil",
    },
    TargetDef {
        id: "sp_cloudflare",
        label: "São Paulo: Cloudflare (1.1.1.1)",
        host: "1.1.1.1",
        port: 443,
        category: "borda_brasil",
    },
    TargetDef {
        id: "sp_vultr",
        label: "São Paulo: Vultr (datacenter)",
        host: "sao-br-ping.vultr.com",
        port: 443,
        category: "borda_brasil",
    },
    TargetDef {
        id: "nicbr_registro",
        label: "NIC.br: registro.br",
        host: "registro.br",
        port: 443,
        category: "ix_nacional",
    },
    TargetDef {
        id: "nicbr_dns",
        label: "NIC.br: a.dns.br",
        host: "a.dns.br",
        port: 443,
        category: "ix_nacional",
    },
    TargetDef {
        id: "us_miami",
        label: "Ref. EUA: Miami (Leaseweb)",
        host: "speedtest.mia11.us.leaseweb.net",
        port: 443,
        category: "referencia_internacional",
    },
    TargetDef {
        id: "us_dallas",
        label: "Ref. EUA: Dallas (Leaseweb)",
        host: "speedtest.dal13.us.leaseweb.net",
        port: 443,
        category: "referencia_internacional",
    },
    TargetDef {
        id: "cloudflare_v6",
        label: "IPv6: Cloudflare",
        host: "2606:4700:4700::1111",
        port: 443,
        category: "ipv6",
    },
    TargetDef {
        id: "google_v6",
        label: "IPv6: Google",
        host: "2001:4860:4860::8888",
        port: 443,
        category: "ipv6",
    },
    TargetDef {
        id: "quad9_v6",
        label: "IPv6: Quad9",
        host: "2620:fe::fe",
        port: 443,
        category: "ipv6",
    },
];

/// Measures round-trip time via real OS ICMP ping
pub fn probe_icmp(host: &str) -> Option<f64> {
    let safe_host: String = host
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(*c, '.' | '-' | ':'))
        .collect();

    if safe_host.is_empty() {
        return None;
    }
    let v6 = safe_host.contains(':');

    let run = |program: &str, args: Vec<String>| -> Option<f64> {
        let mut cmd = Command::new(program);
        cmd.args(&args);
        // Without this, every probe flashes a console window in the GUI app on Windows.
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let output = cmd.output().ok()?;
        parse_ping_output(&String::from_utf8_lossy(&output.stdout))
    };
    let own = |v: &[&str]| -> Vec<String> { v.iter().map(|s| s.to_string()).collect() };

    #[cfg(target_os = "windows")]
    {
        let mut args = own(&["-n", "2", "-w", "800"]);
        if v6 {
            args.insert(0, "-6".into());
        }
        args.push(safe_host);
        run("ping", args)
    }
    #[cfg(target_os = "macos")]
    {
        if v6 {
            run("ping6", own(&["-c", "2", &safe_host]))
        } else {
            run("ping", own(&["-c", "2", "-W", "1000", &safe_host]))
        }
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let args = own(&["-c", "2", "-i", "0.2", "-W", "1", &safe_host]);
        // iputils `ping` handles IPv6 literals itself; older/minimal systems ship a separate `ping6`
        let first = run("ping", args.clone());
        if first.is_none() && v6 {
            run("ping6", args)
        } else {
            first
        }
    }
}

/// Extracts the average RTT (ms) from `ping` output. Locale-independent: Windows prints
/// localized labels in an OEM code page ("Média", "Media", "Moyenne"...), so it keys on the
/// `= Nms` summary shape instead of label text.
pub fn parse_ping_output(text: &str) -> Option<f64> {
    // Linux/macOS: "rtt min/avg/max/mdev = 12.345/14.567/..."
    if let Some(pos) = text.find("min/avg/max") {
        let remainder = &text[pos..];
        if let Some(eq_pos) = remainder.find('=') {
            let parts: Vec<&str> = remainder[eq_pos + 1..].trim().split('/').collect();
            if parts.len() >= 2 {
                if let Ok(avg) = parts[1].trim().parse::<f64>() {
                    return Some((avg * 10.0).round() / 10.0);
                }
            }
        }
    }

    // Windows summary line: "<min> = 12ms, <max> = 15ms, <avg> = 13ms" — the last value is the average.
    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.matches("ms").count() >= 3 {
            if let Some(pos) = lower.rfind('=') {
                let digits: String = lower[pos + 1..]
                    .chars()
                    .skip_while(|c| !c.is_ascii_digit())
                    .take_while(|c| c.is_ascii_digit() || *c == '.')
                    .collect();
                if let Ok(val) = digits.parse::<f64>() {
                    return Some(val);
                }
            }
        }
    }

    // Fallback: single reply "time=14.5 ms" / "tempo=14ms" / "time<1ms"
    for line in text.lines() {
        let lower = line.to_lowercase();
        if !lower.contains("ttl") {
            continue;
        }
        if let Some(idx) = lower.find(|c| c == '=' || c == '<').and_then(|_| lower.find("ms")) {
            let before = &lower[..idx];
            let num_rev: String = before
                .trim_end()
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            let num: String = num_rev.chars().rev().collect();
            if let Ok(v) = num.parse::<f64>() {
                return Some((v * 10.0).round() / 10.0);
            }
        }
    }

    None
}

/// Measures round-trip time via low-level TCP socket handshake
pub fn probe_tcp(host: &str, port: u16) -> Option<f64> {
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs().ok()?.collect();
    if addrs.is_empty() {
        return None;
    }

    let timeout = Duration::from_millis(800);
    let start = Instant::now();
    let stream = TcpStream::connect_timeout(&addrs[0], timeout);
    let elapsed = ((start.elapsed().as_secs_f64() * 1000.0) * 10.0).round() / 10.0;

    match stream {
        Ok(_) => Some(elapsed),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Some(elapsed),
        Err(_) => None,
    }
}

/// Dual-engine probe: attempts native ICMP ping first, falls back to TCP handshake
pub fn probe_host(host: &str, port: u16) -> (Option<f64>, bool) {
    if let Some(rtt) = probe_icmp(host) {
        return (Some(rtt), true);
    }

    if let Some(rtt) = probe_tcp(host, port) {
        return (Some(rtt), true);
    }

    (None, false)
}

/// Probes the user's own router and the first ISP hop (ICMP only; these are private/ISP addresses
/// that make no sense for TCP fallback). Unanswered probes stay `None`.
pub fn probe_path_points(gateway: &str, isp_hop: Option<&str>) -> Vec<StrategicEndpoint> {
    let mut points: Vec<(&str, &str, &str)> = vec![("local_gateway", "Seu roteador (gateway)", gateway)];
    if let Some(ip) = isp_hop {
        points.push(("isp_hop1", "Primeiro salto do ISP", ip));
    }
    points
        .into_iter()
        .map(|(id, label, host)| {
            let rtt = probe_icmp(host);
            StrategicEndpoint {
                id: id.into(),
                label: label.into(),
                host: host.into(),
                category: "caminho".into(),
                rtt_ms: rtt,
                online: rtt.is_some(),
                status: if rtt.is_some() { "OK".into() } else { "TIMEOUT".into() },
            }
        })
        .collect()
}

/// Concurrently probes all strategic Microsoft xCloud, Peering, and International targets
pub fn probe_all_strategic(custom_host: Option<String>) -> TelemetryProbeResponse {
    let handles: Vec<_> = STRATEGIC_TARGETS
        .iter()
        .map(|target| {
            let id = target.id.to_string();
            let label = target.label.to_string();
            let host = target.host.to_string();
            let port = target.port;
            let category = target.category.to_string();

            std::thread::spawn(move || {
                // Raw measurement only: a failed probe is reported as a failed probe.
                let (final_rtt, final_online) = probe_host(&host, port);

                let status = match (final_online, final_rtt) {
                    (true, Some(_)) if category == "referencia_internacional" => "REF-EUA".to_string(),
                    (true, Some(ms)) if ms <= 45.0 => "BOA".to_string(),
                    (true, Some(ms)) if ms <= 65.0 => "ATENÇÃO".to_string(),
                    (true, Some(_)) => "RUIM".to_string(),
                    _ => {
                        if category == "referencia_internacional" {
                            "REF-EUA".to_string()
                        } else {
                            "TIMEOUT".to_string()
                        }
                    }
                };

                StrategicEndpoint {
                    id,
                    label,
                    host,
                    category,
                    rtt_ms: final_rtt,
                    online: final_online,
                    status,
                }
            })
        })
        .collect();

    let mut endpoints: Vec<StrategicEndpoint> = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(ep) = handle.join() {
            endpoints.push(ep);
        }
    }

    let mut custom_result = None;
    if let Some(ref ch) = custom_host {
        let (rtt, online) = probe_host(ch, 443);
        custom_result = Some(CustomHostResult {
            host: ch.clone(),
            rtt_ms: rtt,
            online: online || rtt.is_some(),
        });
    }

    let min_rtt = |category: &str| -> Option<f64> {
        endpoints
            .iter()
            .filter(|t| t.category == category)
            .filter_map(|t| t.rtt_ms)
            .reduce(f64::min)
    };
    let rtt_of = |id: &str| -> Option<f64> {
        endpoints.iter().find(|t| t.id == id).and_then(|t| t.rtt_ms)
    };
    let sp_edge_rtt = min_rtt("borda_brasil");
    let azure_rtt = min_rtt("azure_brazilsouth");
    let us_miami_rtt = rtt_of("us_miami");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    TelemetryProbeResponse {
        timestamp,
        endpoints,
        sp_edge_rtt,
        azure_rtt,
        us_miami_rtt,
        custom_host: custom_result,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_ping_output;

    #[test]
    fn parses_linux_and_macos_summary() {
        let out = "2 packets transmitted, 2 received\nrtt min/avg/max/mdev = 12.345/14.567/16.0/1.2 ms";
        assert_eq!(parse_ping_output(out), Some(14.6));
        let mac = "round-trip min/avg/max/stddev = 10.1/11.2/12.3/0.9 ms";
        assert_eq!(parse_ping_output(mac), Some(11.2));
    }

    #[test]
    fn parses_windows_in_any_locale() {
        let en = "Reply from 1.1.1.1: bytes=32 time=14ms TTL=57\n    Minimum = 12ms, Maximum = 15ms, Average = 13ms";
        assert_eq!(parse_ping_output(en), Some(13.0));
        let pt = "    M\u{fffd}nimo = 12ms, M\u{fffd}ximo = 15ms, M\u{fffd}dia = 14ms";
        assert_eq!(parse_ping_output(pt), Some(14.0));
    }

    #[test]
    fn parses_single_reply_fallback() {
        assert_eq!(parse_ping_output("Resposta de 1.1.1.1: bytes=32 tempo=18ms TTL=57"), Some(18.0));
        assert_eq!(parse_ping_output("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=14.5 ms"), Some(14.5));
        assert_eq!(parse_ping_output("Request timed out."), None);
    }

    use super::*;

    #[test]
    fn test_probe_host_sanitization() {
        // Unsafe characters should be rejected gracefully without panicking
        let (rtt, online) = probe_host("invalid; rm -rf /; 127.0.0.1", 443);
        assert!(rtt.is_none() || online);
    }

    #[test]
    fn test_probe_all_strategic_structure() {
        let probe = probe_all_strategic(None);
        assert_eq!(probe.endpoints.len(), STRATEGIC_TARGETS.len());
        // Values are network-dependent; unmeasured ones must be None, never a made-up default.
        for ep in &probe.endpoints {
            assert_eq!(ep.rtt_ms.is_some(), ep.online);
        }
    }
}
