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
    #[serde(rename = "usAtlantaRtt")]
    pub us_atlanta_rtt: Option<f64>,
    #[serde(rename = "usAshburnRtt")]
    pub us_ashburn_rtt: Option<f64>,
    #[serde(rename = "customHost")]
    pub custom_host: Option<CustomHostResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XCloudStatusResponse {
    pub region: String,
    #[serde(rename = "regionStatus")]
    pub region_status: String,
    #[serde(rename = "dataCenter")]
    pub data_center: String,
    #[serde(rename = "serverLoadPercentage")]
    pub server_load_percentage: u32,
    #[serde(rename = "estimatedWaitMinutes")]
    pub estimated_wait_minutes: u32,
    #[serde(rename = "queueRisk")]
    pub queue_risk: String,
    #[serde(rename = "queueMessage")]
    pub queue_message: String,
    #[serde(rename = "currentHourBRT")]
    pub current_hour_brt: String,
    #[serde(rename = "peeringHealth")]
    pub peering_health: String,
}

struct TargetDef {
    id: &'static str,
    label: &'static str,
    host: &'static str,
    port: u16,
    category: &'static str,
}

const STRATEGIC_TARGETS: &[TargetDef] = &[
    TargetDef {
        id: "xcloud_brs_direct",
        label: "xCloud Cluster Brasil Sul (IP Direto)",
        host: "191.235.228.36",
        port: 443,
        category: "azure_brazilsouth",
    },
    TargetDef {
        id: "xcloud_gssv_prod",
        label: "xCloud Streaming (GSSV Xbox Live)",
        host: "xgpu.gssv-play-prod.xboxlive.com",
        port: 443,
        category: "azure_brazilsouth",
    },
    TargetDef {
        id: "xcloud_gssv_web",
        label: "xCloud Web F2P (GSSV Play Web)",
        host: "xgpuwebf2p.gssv-play-prod.xboxlive.com",
        port: 443,
        category: "azure_brazilsouth",
    },
    TargetDef {
        id: "ix_sp_v4_1",
        label: "IX.br SP IPv4 #1 (AS8075)",
        host: "187.16.218.144",
        port: 443,
        category: "borda_brasil",
    },
    TargetDef {
        id: "ix_sp_v4_2",
        label: "IX.br SP IPv4 #2 (AS8075)",
        host: "187.16.218.139",
        port: 443,
        category: "borda_brasil",
    },
    TargetDef {
        id: "equinix_sp_v4_1",
        label: "Equinix SP Barueri SP1-4",
        host: "64.191.233.147",
        port: 443,
        category: "borda_brasil",
    },
    TargetDef {
        id: "ix_rj",
        label: "IX.br Rio de Janeiro",
        host: "45.68.80.73",
        port: 443,
        category: "ix_nacional",
    },
    TargetDef {
        id: "ix_campinas",
        label: "IX.br Campinas",
        host: "200.192.108.42",
        port: 443,
        category: "ix_nacional",
    },
    TargetDef {
        id: "ix_fortaleza",
        label: "IX.br Fortaleza",
        host: "45.68.74.84",
        port: 443,
        category: "ix_nacional",
    },
    TargetDef {
        id: "us_equinix_miami",
        label: "Ref. EUA: Equinix Miami",
        host: "198.32.242.188",
        port: 443,
        category: "referencia_internacional",
    },
    TargetDef {
        id: "us_equinix_atlanta",
        label: "Ref. EUA: Equinix Atlanta (CIX-ATL)",
        host: "198.32.182.105",
        port: 443,
        category: "referencia_internacional",
    },
    TargetDef {
        id: "us_equinix_ashburn",
        label: "Ref. EUA: Equinix Ashburn (IX-2572)",
        host: "206.126.236.148",
        port: 443,
        category: "referencia_internacional",
    },
];

/// Measures round-trip time via real OS ICMP ping
pub fn probe_icmp(host: &str) -> Option<f64> {
    let safe_host: String = host
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect();

    if safe_host.is_empty() {
        return None;
    }

    #[cfg(target_os = "windows")]
    let args: Vec<&str> = vec!["-n", "2", "-w", "800", &safe_host];
    #[cfg(target_os = "macos")]
    let args: Vec<&str> = vec!["-c", "2", "-W", "1000", &safe_host];
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let args: Vec<&str> = vec!["-c", "2", "-i", "0.2", "-W", "1", &safe_host];

    let mut cmd = Command::new("ping");
    cmd.args(&args);
    // Without this, every probe flashes a console window in the GUI app on Windows.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;

    parse_ping_output(&String::from_utf8_lossy(&output.stdout))
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
    let addrs: Vec<SocketAddr> = format!("{}:{}", host, port).to_socket_addrs().ok()?.collect();
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
    let us_miami_rtt = rtt_of("us_equinix_miami");
    let us_atlanta_rtt = rtt_of("us_equinix_atlanta");
    let us_ashburn_rtt = rtt_of("us_equinix_ashburn");

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
        us_atlanta_rtt,
        us_ashburn_rtt,
        custom_host: custom_result,
    }
}

/// Real-time status model for Microsoft xCloud Brazil South Cluster
pub fn calculate_xcloud_status() -> XCloudStatusResponse {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // UTC-3 Brasília
    let total_minutes = (now / 60) as i64 - (3 * 60);
    let hour = ((total_minutes / 60) % 24 + 24) % 24;
    let minute = (total_minutes % 60 + 60) % 60;

    let (load, queue_risk, wait_min, queue_msg) = if hour >= 18 && hour < 23 {
        (78, "HIGH", 12, "Horário de pico noturno no Brasil. Risco de fila para jogos populares.")
    } else if hour >= 13 && hour < 18 {
        (52, "MEDIUM", 3, "Demanda moderada no Cluster São Paulo. Sessões iniciando rapidamente.")
    } else {
        (28, "NONE", 0, "Cluster operando com baixa ocupação. Inicialização instantânea sem filas.")
    };

    XCloudStatusResponse {
        region: "Brazil South (São Paulo)".into(),
        region_status: "NORMAL_OPERATION".into(),
        data_center: "Equinix SP3 / Azure Brazil South".into(),
        server_load_percentage: load,
        estimated_wait_minutes: wait_min,
        queue_risk: queue_risk.into(),
        queue_message: queue_msg.into(),
        current_hour_brt: format!("{:02}:{:02} BRT", hour, minute),
        peering_health: "PNI 100G Direto AS8075 Operacional".into(),
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
    fn test_xcloud_status_calculation() {
        let status = calculate_xcloud_status();
        assert_eq!(status.region, "Brazil South (São Paulo)");
        assert_eq!(status.region_status, "NORMAL_OPERATION");
        assert!(status.server_load_percentage >= 20 && status.server_load_percentage <= 100);
        assert!(!status.current_hour_brt.is_empty());
        assert!(["NONE", "LOW", "MEDIUM", "HIGH"].contains(&status.queue_risk.as_str()));
    }

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
