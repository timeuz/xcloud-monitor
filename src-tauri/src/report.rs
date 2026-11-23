//! Evidence report for the ISP: a single self-contained HTML file (no scripts, no external
//! resources) that prints cleanly to PDF. Everything in it comes from stored measurements.

use crate::analysis::{Episode, Insight, Report, SegmentStats};
use crate::history::HistoryStats;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopRow {
    pub ttl: u32,
    pub ip: String,
    pub host: String,
    pub rtt_ms: f64,
    pub location: String,
    #[serde(default)]
    pub is_anomaly: bool,
}

#[derive(Debug, Clone)]
pub struct RouteRunDetail {
    pub ts: i64,
    pub hairpin: bool,
    pub detected_pop: Option<String>,
    pub source: Option<String>,
    pub hops: Vec<HopRow>,
}

#[derive(Debug, Clone)]
pub struct BloatDetail {
    pub ts: i64,
    pub idle_rtt: f64,
    pub delta: f64,
    pub down_mbps: Option<f64>,
    pub up_mbps: Option<f64>,
    pub delta_down: Option<f64>,
    pub delta_up: Option<f64>,
    pub grade: Option<String>,
}

pub struct Extras {
    pub routes: Vec<RouteRunDetail>,
    pub bloats: Vec<BloatDetail>,
    pub udp: Vec<crate::history::UdpRunRow>,
    pub sessions: Vec<crate::session::SessionRun>,
    pub stats: HistoryStats,
}

pub struct Meta {
    pub tz_offset_min: i32,
    pub app_version: &'static str,
    pub os: &'static str,
}

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// "DD/MM/YYYY HH:MM" in the user's local time (civil-from-days, no external crate).
pub fn fmt_local(ts: i64, tz_offset_min: i32) -> String {
    let local = ts + tz_offset_min as i64 * 60;
    let days = local.div_euclid(86_400);
    let secs = local.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{d:02}/{m:02}/{y} {:02}:{:02}", secs / 3600, (secs % 3600) / 60)
}

fn ms(v: Option<f64>) -> String {
    v.map(|x| format!("{x:.1} ms")).unwrap_or_else(|| "—".into())
}

fn cause_label(c: &str) -> &'static str {
    match c {
        "local" => "Rede local (o seu roteador também degradou)",
        "isp-access" => "Acesso da operadora (1º salto após o seu roteador)",
        "isp-core" => "Núcleo da operadora (roteador e 1º salto estáveis)",
        "beyond-local" => "Fora da rede local (sem dado do 1º salto)",
        "microsoft-path" => "Caminho até a Microsoft (demais alvos normais)",
        _ => "Não determinada",
    }
}

fn kind_label(k: &str) -> &'static str {
    match k {
        "perda" => "Perda de pacotes",
        "mista" => "Latência e perda",
        _ => "Latência alta",
    }
}

fn sev_class(s: &str) -> &'static str {
    match s {
        "critical" => "crit",
        "warn" => "warn",
        _ => "info",
    }
}

fn table(headers: &[&str], rows: Vec<Vec<String>>) -> String {
    let mut out = String::from("<table><thead><tr>");
    for h in headers {
        out.push_str(&format!("<th>{}</th>", esc(h)));
    }
    out.push_str("</tr></thead><tbody>");
    for row in rows {
        out.push_str("<tr>");
        for cell in row {
            out.push_str(&format!("<td>{cell}</td>")); // cells are escaped by the caller
        }
        out.push_str("</tr>");
    }
    out.push_str("</tbody></table>");
    out
}

fn insights_html(insights: &[Insight]) -> String {
    let mut sorted: Vec<&Insight> = insights.iter().collect();
    let rank = |s: &str| match s {
        "critical" => 0,
        "warn" => 1,
        _ => 2,
    };
    sorted.sort_by_key(|i| rank(&i.severity));
    if sorted.is_empty() {
        return "<p>Nenhum achado relevante no período.</p>".into();
    }
    let mut out = String::new();
    for i in sorted {
        out.push_str(&format!(
            "<div class=\"finding {}\"><b>{}</b><br>{}",
            sev_class(&i.severity),
            esc(&i.title),
            esc(&i.detail)
        ));
        if let Some(s) = &i.suggestion {
            out.push_str(&format!("<br><i>{}</i>", esc(s)));
        }
        out.push_str("</div>");
    }
    out
}

fn path_html(path: &[SegmentStats]) -> String {
    if path.is_empty() {
        return "<p>Sem dados do caminho (roteador / primeiro salto do ISP) ainda.</p>".into();
    }
    let rows = path
        .iter()
        .map(|s| {
            let during = s
                .during_episodes
                .as_ref()
                .map(|d| format!("{} · p95 {} · perda {:.1}%", ms(d.p50), ms(d.p95), d.loss_pct))
                .unwrap_or_else(|| "—".into());
            vec![
                esc(&s.label),
                s.samples.to_string(),
                ms(s.p50),
                ms(s.p95),
                ms(s.jitter),
                format!("{:.2}%", s.loss_pct),
                esc(&during),
            ]
        })
        .collect();
    table(
        &["Ponto medido", "Amostras", "Mediana", "p95 típico", "Jitter", "Perda", "Durante os episódios ruins (mediana · p95 · perda)"],
        rows,
    )
}

fn episodes_html(episodes: &[Episode], tz: i32) -> String {
    if episodes.is_empty() {
        return "<p>Nenhum episódio de degradação (3 min ou mais) no período.</p>".into();
    }
    let rows = episodes
        .iter()
        .map(|e| {
            vec![
                esc(&fmt_local(e.start, tz)),
                format!("{} min", e.duration_min),
                esc(kind_label(&e.kind)),
                ms(e.peak_rtt),
                format!("{:.1}%", e.loss_pct),
                esc(cause_label(&e.cause)),
                if e.route_hairpin { "Sim".into() } else { "Não".into() },
            ]
        })
        .collect();
    table(&["Início (hora local)", "Duração", "Tipo", "Pico de RTT", "Perda", "Onde começou", "Rota desviada p/ EUA"], rows)
}

fn profile_html(title: &str, profile: &[crate::analysis::HourProfile]) -> String {
    if profile.is_empty() {
        return String::new();
    }
    let rows = profile
        .iter()
        .map(|p| {
            vec![
                format!("{:02}h", p.hour),
                ms(Some(p.p50)),
                ms(p.p95),
                format!("{:.1}%", p.loss_pct),
                ms(p.jitter),
                p.days.to_string(),
            ]
        })
        .collect();
    format!("<h3>{}</h3>{}", esc(title), table(&["Hora", "Mediana", "p95", "Perda", "Jitter", "Dias com dado"], rows))
}

fn route_html(run: &RouteRunDetail, tz: i32, heading: &str) -> String {
    let rows = run
        .hops
        .iter()
        .map(|h| {
            let mark = if h.is_anomaly { " ⚠" } else { "" };
            vec![
                h.ttl.to_string(),
                esc(&h.ip),
                esc(&h.host),
                format!("{:.1} ms{mark}", h.rtt_ms),
                esc(&h.location),
            ]
        })
        .collect();
    format!(
        "<h3>{}</h3><p>Medido em {} com {}{}.</p>{}",
        esc(heading),
        esc(&fmt_local(run.ts, tz)),
        esc(run.source.as_deref().unwrap_or("traceroute")),
        run.detected_pop.as_deref().map(|p| format!(" — desvio detectado: {}", esc(p))).unwrap_or_default(),
        table(&["Salto", "IP", "Nome", "RTT", "Local inferido"], rows)
    )
}

/// One step where latency is added between two consecutive responding hops.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Jump {
    pub from_ttl: u32,
    pub from_ip: String,
    pub to_ttl: u32,
    pub to_ip: String,
    pub delta_ms: f64,
    pub to_rtt: f64,
}

/// Where along the path latency is added. Per-hop RTTs are noisy (routers answer ICMP at low
/// priority, so one hop can show 110 ms while everything after it shows 42 ms). The RTT to a later
/// hop can never really be lower than to an earlier one, so each hop is replaced by the minimum
/// over itself and all later hops before measuring the steps.
pub fn latency_jumps(hops: &[HopRow], min_delta_ms: f64) -> Vec<Jump> {
    if hops.len() < 2 {
        return vec![];
    }
    let mut eff: Vec<f64> = hops.iter().map(|h| h.rtt_ms).collect();
    for i in (0..eff.len() - 1).rev() {
        eff[i] = eff[i].min(eff[i + 1]);
    }
    let mut jumps: Vec<Jump> = (1..hops.len())
        .filter(|&i| eff[i] - eff[i - 1] >= min_delta_ms)
        .map(|i| Jump {
            from_ttl: hops[i - 1].ttl,
            from_ip: hops[i - 1].ip.clone(),
            to_ttl: hops[i].ttl,
            to_ip: hops[i].ip.clone(),
            delta_ms: eff[i] - eff[i - 1],
            to_rtt: eff[i],
        })
        .collect();
    jumps.sort_by(|a, b| b.delta_ms.partial_cmp(&a.delta_ms).unwrap_or(std::cmp::Ordering::Equal));
    jumps.truncate(3);
    jumps
}

fn is_private_ip(ip: &str) -> bool {
    ip.parse::<std::net::Ipv4Addr>().map(|a| a.is_private() || a.octets()[0] == 100).unwrap_or(false)
}

fn jumps_html(run: &RouteRunDetail) -> String {
    let jumps = latency_jumps(&run.hops, 5.0);
    if jumps.is_empty() {
        return String::new();
    }
    let rows = jumps
        .iter()
        .map(|j| {
            let owner = if is_private_ip(&j.from_ip) && is_private_ip(&j.to_ip) {
                "Dentro da rede da operadora (endereços privados dos dois lados)"
            } else if is_private_ip(&j.from_ip) {
                "Saída da rede da operadora"
            } else {
                "Rede pública"
            };
            vec![
                format!("{} → {}", j.from_ttl, j.to_ttl),
                format!("{} → {}", esc(&j.from_ip), esc(&j.to_ip)),
                format!("+{:.1} ms", j.delta_ms),
                format!("{:.1} ms", j.to_rtt),
                esc(owner),
            ]
        })
        .collect();
    format!(
        "<h3>Onde a latência é acrescentada</h3><p>Maiores acréscimos entre saltos consecutivos (picos isolados de ICMP descartados):</p>{}",
        table(&["Saltos", "Endereços", "Acréscimo", "RTT acumulado", "Trecho"], rows)
    )
}

fn session_html(runs: &[crate::session::SessionRun], tz: i32) -> String {
    if runs.is_empty() {
        return "<p>Nenhum servidor de sessão de jogo foi medido. O endereço muda a cada partida; informe-o na aba Histórico enquanto joga.</p>".into();
    }
    let rows = runs
        .iter()
        .map(|r| {
            let vs_entry = match (r.rtt_p50, r.entry_rtt) {
                (Some(a), Some(b)) => format!("{:+.1} ms", a - b),
                _ => "—".into(),
            };
            let route = if r.hop_count == 0 {
                "não medida".to_string()
            } else if r.hairpin {
                format!("{} saltos · desvio internacional", r.hop_count)
            } else {
                format!("{} saltos", r.hop_count)
            };
            let jump = r
                .largest_jump
                .as_ref()
                .map(|j| format!("+{:.0} ms entre os saltos {} e {}", j.delta_ms, j.from_ttl, j.to_ttl))
                .unwrap_or_else(|| "—".into());
            vec![
                esc(&fmt_local(r.ts, tz)),
                esc(&r.peer_ip),
                esc(r.note.as_deref().unwrap_or("")),
                if r.icmp_blocked { "não responde a ICMP".into() } else { ms(r.rtt_p50) },
                ms(r.rtt_p95),
                format!("{:.1}%", r.loss_pct),
                vs_entry,
                esc(&route),
                esc(&jump),
            ]
        })
        .collect();
    format!(
        "<p>Servidor de mídia da partida (o IP muda a cada sessão), medido durante o jogo. \"Diferença para a entrada\" compara com o servidor de entrada do xCloud medido no mesmo momento: um valor grande indica que a partida foi alocada longe.</p>{}",
        table(&["Data", "Servidor", "Nota", "RTT mediano", "RTT p95", "Perda", "Diferença para a entrada", "Rota", "Maior acréscimo"], rows)
    )
}

fn udp_html(runs: &[crate::history::UdpRunRow], tz: i32) -> String {
    if runs.is_empty() {
        return "<p>Nenhum teste UDP realizado no período.</p>".into();
    }
    let rows = runs
        .iter()
        .map(|r| {
            vec![
                esc(&fmt_local(r.ts, tz)),
                esc(&r.label),
                format!("{} / {}", r.received, r.sent),
                format!("{:.1}%", r.loss_pct),
                r.max_burst.to_string(),
                ms(r.rtt_p50),
                ms(r.rtt_p95),
                ms(r.jitter),
            ]
        })
        .collect();
    format!(
        "<p>50 pacotes UDP por segundo durante 10 s para servidores STUN públicos. Mede a rota em UDP (o protocolo do jogo), não a banda.</p>{}",
        table(&["Data", "Servidor", "Recebidos", "Perda", "Maior sequência perdida", "RTT mediano", "RTT p95", "Jitter"], rows)
    )
}

fn bloat_html(bloats: &[BloatDetail], tz: i32) -> String {
    if bloats.is_empty() {
        return "<p>Nenhum teste de bufferbloat realizado no período.</p>".into();
    }
    let n = |v: Option<f64>, unit: &str| v.map(|x| format!("{x:.1} {unit}")).unwrap_or_else(|| "—".into());
    let rows = bloats
        .iter()
        .map(|b| {
            vec![
                esc(&fmt_local(b.ts, tz)),
                format!("{:.1} ms", b.idle_rtt),
                n(b.delta_down.or(Some(b.delta)), "ms"),
                n(b.delta_up, "ms"),
                n(b.down_mbps, "Mbps"),
                n(b.up_mbps, "Mbps"),
                esc(b.grade.as_deref().unwrap_or("—")),
            ]
        })
        .collect();
    table(&["Data", "RTT em repouso", "Aumento no download", "Aumento no upload", "Download", "Upload", "Nota"], rows)
}

const CSS: &str = "body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:980px;margin:24px auto;padding:0 16px}\
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;border-bottom:2px solid #222;padding-bottom:3px;margin-top:28px}h3{font-size:14px;margin:16px 0 4px}\
table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee}\
.finding{border-left:5px solid #888;background:#f6f6f6;padding:6px 10px;margin:6px 0}.crit{border-color:#b00020}.warn{border-color:#e08a00}.info{border-color:#2a6fb0}\
.meta{color:#444;font-size:12px}.box{border:1px dashed #888;padding:8px;margin:8px 0;font-size:12px}\
@media print{body{margin:0}h2{page-break-after:avoid}table{page-break-inside:auto}tr{page-break-inside:avoid}}";

pub fn render(report: &Report, extras: &Extras, meta: &Meta) -> String {
    let tz = meta.tz_offset_min;
    let period = match (extras.stats.oldest_ts, extras.stats.newest_ts) {
        (Some(a), Some(b)) => format!("{} a {}", fmt_local(a, tz), fmt_local(b, tz)),
        _ => "sem dados".into(),
    };

    let mut html = String::new();
    html.push_str("<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><title>Relatório de qualidade de conexão</title>");
    html.push_str(&format!("<style>{CSS}</style></head><body>"));
    html.push_str("<h1>Relatório de qualidade de conexão — Xbox Cloud Gaming (Brasil)</h1>");
    html.push_str(&format!(
        "<p class=\"meta\">Gerado em {} (hora local) · xCloud Cyber-Monitor v{} · {} · período dos dados brutos: {} · janela analisada: {} dias · cobertura: {} h · sondagem a cada {} s · confiança da análise: {}</p>",
        esc(&fmt_local(report.generated_at, tz)),
        esc(meta.app_version),
        esc(meta.os),
        esc(&period),
        report.window_days,
        report.coverage_hours,
        extras.stats.interval_secs,
        esc(&report.confidence),
    ));
    html.push_str("<div class=\"box\"><b>Dados do cliente (preencher):</b> Nome: ____________________ · Contrato/CPF: ____________________ · IP público: ____________________ · Plano contratado: ____________________</div>");

    html.push_str("<h2>1. Achados</h2>");
    html.push_str(&insights_html(&report.insights));

    html.push_str("<h2>2. Comparação do caminho: seu roteador × operadora × servidor xCloud</h2>");
    html.push_str("<p>Os três pontos são medidos ao mesmo tempo. Se o roteador (dentro da casa do cliente) se mantém estável enquanto os pontos seguintes degradam, o problema está depois da rede local.</p>");
    html.push_str(&path_html(&report.path_comparison));

    html.push_str("<h2>3. Episódios de degradação</h2>");
    html.push_str(&episodes_html(&report.episodes, tz));

    html.push_str("<h2>4. Comportamento por horário</h2>");
    html.push_str(&profile_html("Dias úteis (servidor xCloud)", &report.profile_weekday));
    html.push_str(&profile_html("Fins de semana (servidor xCloud)", &report.profile_weekend));

    html.push_str("<h2>5. Rota até o servidor</h2>");
    let bad = extras.routes.iter().find(|r| r.hairpin);
    let good = extras.routes.iter().find(|r| !r.hairpin);
    match (bad, good) {
        (None, None) => html.push_str("<p>Nenhuma rota registrada.</p>"),
        (b, g) => {
            if let Some(r) = b {
                html.push_str(&route_html(r, tz, "Rota com desvio internacional (mais recente)"));
            }
            if let Some(r) = g {
                html.push_str(&route_html(r, tz, "Rota nacional (mais recente)"));
            }
            if let Some(r) = b.or(g) {
                html.push_str(&jumps_html(r));
            }
        }
    }

    html.push_str("<h2>6. Bufferbloat (latência com a linha ocupada)</h2>");
    html.push_str(&bloat_html(&extras.bloats, tz));

    html.push_str("<h2>7. Teste UDP (rota do jogo)</h2>");
    html.push_str(&udp_html(&extras.udp, tz));

    html.push_str("<h2>8. Servidor real da sessão de jogo</h2>");
    html.push_str(&session_html(&extras.sessions, tz));

    html.push_str("<h2>9. Alvos medidos</h2>");
    let rows = report
        .targets
        .iter()
        .map(|t| {
            vec![
                esc(&t.id),
                t.samples.to_string(),
                format!("{:.1}%", t.answer_rate * 100.0),
                ms(t.p50),
                ms(t.p95),
                esc(&t.status),
            ]
        })
        .collect();
    html.push_str(&table(&["Alvo", "Amostras", "Respostas", "Mediana", "p95 típico", "Situação"], rows));

    html.push_str("<h2>10. Metodologia e limitações</h2><ul>\
<li>Latência medida por ICMP (ping), com TCP/443 como alternativa, a cada 30 s, a partir do computador do cliente. Perda = sondagens sem resposta.</li>\
<li>Um episódio é um período de pelo menos 3 minutos com perda ≥ 20% ou mediana acima de 1,5× a base (e ≥ 15 ms). Roteador e 1º salto usam limite de +10 ms.</li>\
<li>O primeiro salto do ISP é o primeiro endereço, depois do roteador do cliente, que aparece no traceroute.</li>\
<li>Desvio internacional: nome de salto com código de cidade dos EUA, ou salto de latência ≥ 60 ms que se mantém acima de 90 ms em pelo menos dois saltos.</li>\
<li>Limitações: ICMP pode ter prioridade menor que o tráfego de jogo; alvos que bloqueiam ICMP/TCP aparecem como sem resposta; o servidor real da sessão de jogo só é conhecido durante a partida. Recomenda-se confirmar os números com uma ferramenta independente (por exemplo, medições do NIC.br ou do Measurement Lab).</li>\
<li>Os dados brutos (CSV) estão disponíveis em Configurações &gt; Exportar CSV e podem ser anexados a este relatório.</li></ul>");
    html.push_str("</body></html>");
    html
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::{HourProfile, WindowStats};

    fn stats() -> HistoryStats {
        HistoryStats {
            enabled: true,
            sample_count: 10,
            hourly_count: 1,
            route_runs: 1,
            bufferbloat_runs: 0,
            oldest_ts: Some(0),
            newest_ts: Some(86_400),
            db_bytes: 0,
            interval_secs: 30,
            raw_retention_days: 14,
        }
    }

    fn report() -> Report {
        Report {
            generated_at: 86_400,
            window_days: 14,
            coverage_hours: 48,
            confidence: "low".into(),
            primary_target: Some("xcloud_gssv_prod".into()),
            baseline_p50: Some(36.0),
            targets: vec![],
            profile_weekday: vec![HourProfile { hour: 20, days: 5, p50: 60.0, p95: Some(70.0), loss_pct: 0.5, jitter: Some(3.0) }],
            profile_weekend: vec![],
            peak_hours: vec![],
            episodes: vec![Episode {
                start: 3600,
                end: 4500,
                duration_min: 15,
                kind: "latencia".into(),
                peak_rtt: Some(140.0),
                loss_pct: 0.0,
                scope: "all-targets".into(),
                route_hairpin: false,
                cause: "isp-access".into(),
            }],
            path_comparison: vec![SegmentStats {
                role: "local_gateway".into(),
                label: "Seu roteador (gateway)".into(),
                id: "local_gateway".into(),
                samples: 5000,
                answer_rate: 1.0,
                p50: Some(0.5),
                p95: Some(1.2),
                jitter: Some(0.2),
                loss_pct: 0.0,
                during_episodes: Some(WindowStats { samples: 30, p50: Some(0.6), p95: Some(1.0), loss_pct: 0.0 }),
            }],
            insights: vec![Insight {
                id: "x".into(),
                severity: "warn".into(),
                title: "<script>alert(1)</script>".into(),
                detail: "d & e".into(),
                suggestion: Some("s".into()),
            }],
        }
    }

    fn render_it(extras: Extras) -> String {
        render(&report(), &extras, &Meta { tz_offset_min: -180, app_version: "1.0.0", os: "linux" })
    }

    #[test]
    fn local_time_formatting_is_correct() {
        assert_eq!(fmt_local(0, 0), "01/01/1970 00:00");
        assert_eq!(fmt_local(0, -180), "31/12/1969 21:00");
        // 2024-02-29 12:34 UTC (leap day)
        assert_eq!(fmt_local(1_709_210_040, 0), "29/02/2024 12:34");
        assert_eq!(fmt_local(1_795_385_469, -180), "22/11/2026 19:11");
    }

    #[test]
    fn report_escapes_untrusted_text_and_is_self_contained() {
        let html = render_it(Extras {
            routes: vec![RouteRunDetail {
                ts: 0,
                hairpin: false,
                detected_pop: None,
                source: Some("traceroute".into()),
                hops: vec![HopRow { ttl: 1, ip: "1.1.1.1".into(), host: "<img src=x onerror=alert(1)>".into(), rtt_ms: 1.0, location: "Rede local".into(), is_anomaly: false }],
            }],
            bloats: vec![],
            udp: vec![],
            sessions: vec![],
            stats: stats(),
        });
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(!html.contains("<img src=x"));
        assert!(!html.contains("http://") && !html.contains("https://"));
        assert!(!html.to_lowercase().contains("<script"));
    }

    #[test]
    fn report_has_every_section_and_the_key_numbers() {
        let html = render_it(Extras { routes: vec![], bloats: vec![], udp: vec![],
            sessions: vec![], stats: stats() });
        for section in ["1. Achados", "2. Comparação do caminho", "3. Episódios", "4. Comportamento por horário", "5. Rota", "6. Bufferbloat", "7. Teste UDP", "8. Servidor real", "9. Alvos medidos", "10. Metodologia"] {
            assert!(html.contains(section), "missing {section}");
        }
        assert!(html.contains("Acesso da operadora"));
        assert!(html.contains("0.5 ms") && html.contains("140.0 ms"));
        assert!(html.contains("31/12/1969 22:00")); // episode start = ts 3600, local -3h
        assert!(html.contains("Dados do cliente"));
    }

    #[test]
    fn hairpin_and_normal_routes_are_both_shown_when_available() {
        let hop = |anom| HopRow { ttl: 4, ip: "4.4.4.4".into(), host: "ae1.mia1.x.net".into(), rtt_ms: 118.0, location: "Miami (EUA)".into(), is_anomaly: anom };
        let html = render_it(Extras {
            routes: vec![
                RouteRunDetail { ts: 100, hairpin: true, detected_pop: Some("Miami (EUA)".into()), source: None, hops: vec![hop(true)] },
                RouteRunDetail { ts: 50, hairpin: false, detected_pop: None, source: None, hops: vec![hop(false)] },
            ],
            bloats: vec![],
            udp: vec![],
            sessions: vec![],
            stats: stats(),
        });
        assert!(html.contains("Rota com desvio internacional"));
        assert!(html.contains("Rota nacional"));
        assert!(html.contains("118.0 ms ⚠"));
    }

    fn hop(ttl: u32, ip: &str, rtt: f64) -> HopRow {
        HopRow { ttl, ip: ip.into(), host: ip.into(), rtt_ms: rtt, location: "x".into(), is_anomaly: false }
    }

    #[test]
    fn latency_jumps_ignore_isolated_icmp_spikes_and_find_the_isp_leg() {
        // real measurement: ISP-internal leg 7 -> 11, and a 113 ms ICMP artefact at hop 13
        let hops = vec![
            hop(1, "192.168.1.1", 0.6),
            hop(3, "172.16.112.220", 1.7),
            hop(7, "172.16.114.62", 9.3),
            hop(11, "172.16.16.90", 38.4),
            hop(12, "104.44.197.59", 39.9),
            hop(13, "51.10.21.198", 113.8),
            hop(14, "104.44.34.20", 42.5),
            hop(16, "51.10.8.88", 41.2),
        ];
        let jumps = latency_jumps(&hops, 5.0);
        // largest first: the ISP-internal leg 7 -> 11, then the smaller 3 -> 7 step
        assert_eq!((jumps[0].from_ttl, jumps[0].to_ttl), (7, 11));
        assert!((jumps[0].delta_ms - 29.1).abs() < 0.05);
        // the 113.8 ms ICMP artefact at hop 13 must not show up as a jump
        assert!(jumps.iter().all(|j| j.to_ttl != 13 && j.to_ttl != 14), "{jumps:?}");
    }

    #[test]
    fn jump_section_labels_isp_internal_leg() {
        let run = RouteRunDetail {
            ts: 0,
            hairpin: false,
            detected_pop: None,
            source: None,
            hops: vec![hop(7, "172.16.114.62", 9.3), hop(11, "172.16.16.90", 38.4)],
        };
        let html = jumps_html(&run);
        assert!(html.contains("Dentro da rede da operadora"));
        assert!(html.contains("+29.1 ms"));
    }
}
