//! Deterministic analysis of the local measurement history.
//!
//! No model, no randomness: every number and every sentence below is derived from stored
//! measurements with named thresholds. An LLM may later *narrate* a `Report`, never produce it.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// Targets that are the entry point of the xCloud streaming region, best proxy for game traffic.
pub const PRIMARY_CANDIDATES: &[&str] = &["xcloud_gssv_prod", "xcloud_brs_direct", "xcloud_gssv_web"];

const MIN_SAMPLES_FOR_STATUS: i64 = 20;
const UNREACHABLE_RATE: f64 = 0.05;
const FLAKY_RATE: f64 = 0.90;
/// Targets below this many samples are never reported as "never answers".
const MIN_SAMPLES_TO_DROP: i64 = 200;

const PEAK_RATIO: f64 = 1.25;
const PEAK_MIN_DELTA_MS: f64 = 5.0;
const MIN_DAYS_PER_HOUR: usize = 2;
const MIN_HOURS_FOR_BASELINE: usize = 6;

const SAMPLE_GAP_SECS: i64 = 150; // > 5 sampling intervals = the app was not running
const EPISODE_WINDOW: usize = 10; // 5 minutes of 30 s samples
const EPISODE_MIN_WINDOW: usize = 5;
const EPISODE_MIN_SAMPLES: usize = 6; // 3 minutes
const EPISODE_MERGE_GAP: usize = 4;
const EPISODE_LOSS_FRAC: f64 = 0.2;
const DEGRADE_RATIO: f64 = 1.5;
const DEGRADE_MIN_DELTA_MS: f64 = 15.0;
const ROUTE_WINDOW_SECS: i64 = 600;

/// Probe ids written by the sampler for the segments of the user's path.
pub const GATEWAY_ID: &str = "local_gateway";
pub const ISP_ID: &str = "isp_hop1";
/// Gateway / first ISP hop are sub-millisecond to ~20 ms: judge them on absolute jumps, not on ratios of a tiny base.
const PATH_RATIO: f64 = 2.5;
const PATH_MIN_DELTA_MS: f64 = 10.0;
const LOCAL_CLEAN_ANSWER_RATE: f64 = 0.995;
const LOCAL_CLEAN_P95_MS: f64 = 5.0;
const LOCAL_BAD_ANSWER_RATE: f64 = 0.99;
const LOCAL_BAD_P95_MS: f64 = 15.0;
const LOCAL_MIN_HOURS: usize = 24;

const LOSS_WARN_PCT: f64 = 1.0;
const LOSS_CRIT_PCT: f64 = 5.0;
const JITTER_WARN_MS: f64 = 8.0;
const BLOAT_BAD_MS: f64 = 40.0;
const HAIRPIN_WARN_SHARE: f64 = 0.10;

#[derive(Debug, Clone)]
pub struct HourRow {
    pub hour_ts: i64,
    pub target_id: String,
    pub n: i64,
    pub n_lost: i64,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub jitter: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct RawSample {
    pub ts: i64,
    pub target_id: String,
    pub rtt: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct RouteRow {
    pub ts: i64,
    pub hairpin: bool,
    pub detected_pop: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BloatRow {
    pub ts: i64,
    pub delta: f64,
}

pub struct Inputs<'a> {
    pub hours: &'a [HourRow],
    pub raw: &'a [RawSample],
    pub routes: &'a [RouteRow],
    pub bloats: &'a [BloatRow],
}

#[derive(Debug, Clone, Copy)]
pub struct Params {
    pub now: i64,
    /// Minutes to add to UTC to get the user's local time (BRT = -180).
    pub tz_offset_min: i32,
    pub window_days: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetQuality {
    pub id: String,
    pub samples: i64,
    pub answer_rate: f64,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub jitter: Option<f64>,
    /// ok | flaky | unreachable | insufficient
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourProfile {
    pub hour: u8,
    pub days: usize,
    pub p50: f64,
    pub p95: Option<f64>,
    pub loss_pct: f64,
    pub jitter: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakHour {
    /// weekday | weekend
    pub group: String,
    pub hour: u8,
    pub p50: f64,
    pub baseline: f64,
    pub delta_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub start: i64,
    pub end: i64,
    pub duration_min: i64,
    /// latencia | perda | mista
    pub kind: String,
    pub peak_rtt: Option<f64>,
    pub loss_pct: f64,
    /// all-targets | primary-only | unknown
    pub scope: String,
    pub route_hairpin: bool,
    /// local | isp-access | isp-core | beyond-local | microsoft-path | unknown
    pub cause: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStats {
    pub samples: usize,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub loss_pct: f64,
}

/// One point of the path (router, first ISP hop, xCloud) over the whole window and during episodes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentStats {
    /// local_gateway | isp_hop1 | xcloud
    pub role: String,
    pub label: String,
    pub id: String,
    pub samples: i64,
    pub answer_rate: f64,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub jitter: Option<f64>,
    pub loss_pct: f64,
    pub during_episodes: Option<WindowStats>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub id: String,
    /// info | warn | critical
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub generated_at: i64,
    pub window_days: i64,
    pub coverage_hours: i64,
    /// insufficient | low | medium | high
    pub confidence: String,
    pub primary_target: Option<String>,
    pub baseline_p50: Option<f64>,
    pub targets: Vec<TargetQuality>,
    pub profile_weekday: Vec<HourProfile>,
    pub profile_weekend: Vec<HourProfile>,
    pub peak_hours: Vec<PeakHour>,
    pub episodes: Vec<Episode>,
    pub path_comparison: Vec<SegmentStats>,
    pub insights: Vec<Insight>,
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = v.len() / 2;
    Some(if v.len() % 2 == 1 { v[mid] } else { (v[mid - 1] + v[mid]) / 2.0 })
}

fn mean(v: &[f64]) -> Option<f64> {
    if v.is_empty() {
        None
    } else {
        Some(v.iter().sum::<f64>() / v.len() as f64)
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// (local hour 0-23, local day index since epoch, is_weekend)
fn local_parts(ts: i64, tz_offset_min: i32) -> (u8, i64, bool) {
    let local = ts + tz_offset_min as i64 * 60;
    let day = local.div_euclid(86_400);
    let hour = (local.rem_euclid(86_400) / 3600) as u8;
    // 1970-01-01 was a Thursday; Sunday = 0
    let weekday = (day + 4).rem_euclid(7);
    (hour, day, weekday == 0 || weekday == 6)
}

pub fn target_quality(hours: &[HourRow]) -> Vec<TargetQuality> {
    let mut by_target: BTreeMap<&str, Vec<&HourRow>> = BTreeMap::new();
    for h in hours {
        by_target.entry(h.target_id.as_str()).or_default().push(h);
    }
    by_target
        .into_iter()
        .map(|(id, rows)| {
            let samples: i64 = rows.iter().map(|r| r.n).sum();
            let lost: i64 = rows.iter().map(|r| r.n_lost).sum();
            let answer_rate = if samples > 0 { 1.0 - lost as f64 / samples as f64 } else { 0.0 };
            let status = if samples < MIN_SAMPLES_FOR_STATUS {
                "insufficient"
            } else if answer_rate < UNREACHABLE_RATE {
                "unreachable"
            } else if answer_rate < FLAKY_RATE {
                "flaky"
            } else {
                "ok"
            };
            let jitters: Vec<f64> = rows.iter().filter_map(|r| r.jitter).collect();
            TargetQuality {
                id: id.to_string(),
                samples,
                answer_rate: (answer_rate * 1000.0).round() / 1000.0,
                p50: median(rows.iter().filter_map(|r| r.p50).collect()).map(round1),
                p95: median(rows.iter().filter_map(|r| r.p95).collect()).map(round1),
                jitter: mean(&jitters).map(round1),
                status: status.to_string(),
            }
        })
        .collect()
}

/// Best candidate for "game traffic": an answering xCloud entry point with the lowest typical RTT.
pub fn choose_primary(quality: &[TargetQuality]) -> Option<String> {
    let usable = |q: &&TargetQuality| q.status == "ok" || q.status == "flaky";
    let best = |it: Vec<&TargetQuality>| {
        it.into_iter()
            .filter(usable)
            .filter(|q| q.p50.is_some())
            .min_by(|a, b| a.p50.partial_cmp(&b.p50).unwrap_or(std::cmp::Ordering::Equal))
            .map(|q| q.id.clone())
    };
    best(quality.iter().filter(|q| PRIMARY_CANDIDATES.contains(&q.id.as_str())).collect())
}

fn build_profile(rows: &[&HourRow], tz: i32, weekend: bool) -> Vec<HourProfile> {
    struct Acc {
        p50: Vec<f64>,
        p95: Vec<f64>,
        jitter: Vec<f64>,
        n: i64,
        lost: i64,
        days: BTreeSet<i64>,
    }
    let mut by_hour: BTreeMap<u8, Acc> = BTreeMap::new();
    for r in rows {
        let (hour, day, is_weekend) = local_parts(r.hour_ts, tz);
        if is_weekend != weekend {
            continue;
        }
        let acc = by_hour.entry(hour).or_insert_with(|| Acc {
            p50: vec![],
            p95: vec![],
            jitter: vec![],
            n: 0,
            lost: 0,
            days: BTreeSet::new(),
        });
        acc.n += r.n;
        acc.lost += r.n_lost;
        acc.days.insert(day);
        if let Some(v) = r.p50 {
            acc.p50.push(v);
        }
        if let Some(v) = r.p95 {
            acc.p95.push(v);
        }
        if let Some(v) = r.jitter {
            acc.jitter.push(v);
        }
    }
    by_hour
        .into_iter()
        .filter_map(|(hour, a)| {
            let p50 = median(a.p50)?;
            Some(HourProfile {
                hour,
                days: a.days.len(),
                p50: round1(p50),
                p95: median(a.p95).map(round1),
                loss_pct: if a.n > 0 { round1(a.lost as f64 / a.n as f64 * 100.0) } else { 0.0 },
                jitter: mean(&a.jitter).map(round1),
            })
        })
        .collect()
}

fn find_peaks(profile: &[HourProfile], group: &str) -> Vec<PeakHour> {
    let solid: Vec<&HourProfile> = profile.iter().filter(|p| p.days >= MIN_DAYS_PER_HOUR).collect();
    if solid.len() < MIN_HOURS_FOR_BASELINE {
        return vec![];
    }
    let Some(baseline) = median(solid.iter().map(|p| p.p50).collect()) else { return vec![] };
    solid
        .into_iter()
        .filter(|p| p.p50 >= baseline * PEAK_RATIO && p.p50 - baseline >= PEAK_MIN_DELTA_MS)
        .map(|p| PeakHour {
            group: group.to_string(),
            hour: p.hour,
            p50: p.p50,
            baseline: round1(baseline),
            delta_ms: round1(p.p50 - baseline),
        })
        .collect()
}

/// Index ranges of a time-ordered series, split wherever the app was not sampling (gap > 5 intervals).
fn segment_ranges(samples: &[(i64, Option<f64>)]) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..samples.len() {
        if samples[i].0 - samples[i - 1].0 > SAMPLE_GAP_SECS {
            out.push(start..i);
            start = i;
        }
    }
    if start < samples.len() {
        out.push(start..samples.len());
    }
    out
}

fn is_degraded(window: &[(i64, Option<f64>)], baseline: f64) -> bool {
    is_degraded_with(window, baseline, DEGRADE_RATIO, DEGRADE_MIN_DELTA_MS)
}

fn is_degraded_with(window: &[(i64, Option<f64>)], baseline: f64, ratio: f64, min_delta: f64) -> bool {
    if window.len() < EPISODE_MIN_WINDOW {
        return false;
    }
    let lost = window.iter().filter(|s| s.1.is_none()).count();
    if lost as f64 / window.len() as f64 >= EPISODE_LOSS_FRAC {
        return true;
    }
    let answered: Vec<f64> = window.iter().filter_map(|s| s.1).collect();
    match median(answered) {
        Some(m) => m > (baseline * ratio).max(baseline + min_delta),
        None => true,
    }
}

/// Runs of degraded trailing windows lasting at least 3 minutes. Returns inclusive index ranges.
fn degraded_runs(series: &[(i64, Option<f64>)], baseline: f64) -> Vec<(usize, usize)> {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for range in segment_ranges(series) {
        let base = range.start;
        let seg_slice = &series[range];
        let flags: Vec<bool> = (0..seg_slice.len())
            .map(|i| is_degraded(&seg_slice[(i + 1).saturating_sub(EPISODE_WINDOW)..=i], baseline))
            .collect();

        let mut seg_runs: Vec<(usize, usize)> = Vec::new();
        let mut i = 0;
        while i < flags.len() {
            if flags[i] {
                let start = i;
                while i + 1 < flags.len() && flags[i + 1] {
                    i += 1;
                }
                seg_runs.push((start, i));
            }
            i += 1;
        }
        // merge runs separated by a short recovery
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for r in seg_runs {
            match merged.last_mut() {
                Some(last) if r.0 - last.1 <= EPISODE_MERGE_GAP => last.1 = r.1,
                _ => merged.push(r),
            }
        }
        runs.extend(
            merged
                .into_iter()
                .filter(|(a, b)| b - a + 1 >= EPISODE_MIN_SAMPLES)
                .map(|(a, b)| (a + base, b + base)),
        );
    }
    runs
}

fn series_for<'a>(raw: &'a [RawSample], target: &str) -> Vec<(i64, Option<f64>)> {
    let mut v: Vec<(i64, Option<f64>)> =
        raw.iter().filter(|s| s.target_id == target).map(|s| (s.ts, s.rtt)).collect();
    v.sort_by_key(|s| s.0);
    v
}

fn window_stats(samples: &[Option<f64>]) -> WindowStats {
    let mut ok: Vec<f64> = samples.iter().filter_map(|s| *s).collect();
    ok.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pct = |p: f64| -> Option<f64> {
        if ok.is_empty() {
            return None;
        }
        let rank = ((p / 100.0) * ok.len() as f64).ceil().max(1.0) as usize;
        Some(round1(ok[rank.min(ok.len()) - 1]))
    };
    WindowStats {
        samples: samples.len(),
        p50: pct(50.0),
        p95: pct(95.0),
        loss_pct: if samples.is_empty() { 0.0 } else { round1((samples.len() - ok.len()) as f64 / samples.len() as f64 * 100.0) },
    }
}

/// Where did an episode start? Uses the router and first-ISP-hop verdicts for the same interval.
fn attribute_cause(gateway: Option<bool>, isp: Option<bool>, scope: &str) -> &'static str {
    match (gateway, isp, scope) {
        (Some(true), _, _) => "local",
        (Some(false), Some(true), _) => "isp-access",
        (Some(false), Some(false), "all-targets") => "isp-core",
        (Some(false), None, "all-targets") => "beyond-local",
        (Some(false), _, "primary-only") => "microsoft-path",
        _ => "unknown",
    }
}

#[allow(clippy::too_many_arguments)]
fn find_episodes(
    raw: &[RawSample],
    routes: &[RouteRow],
    primary: &str,
    baseline: f64,
    other_ok_targets: &[String],
    gateway: Option<&str>,
    isp: Option<&str>,
) -> Vec<Episode> {
    let series = series_for(raw, primary);
    let others: Vec<(Vec<(i64, Option<f64>)>, f64)> = other_ok_targets
        .iter()
        .filter_map(|t| {
            let s = series_for(raw, t);
            let base = median(s.iter().filter_map(|x| x.1).collect())?;
            Some((s, base))
        })
        .collect();

    let path_series = |id: Option<&str>| -> Option<(Vec<(i64, Option<f64>)>, f64)> {
        let s = series_for(raw, id?);
        let base = median(s.iter().filter_map(|x| x.1).collect())?;
        Some((s, base))
    };
    let gateway_series = path_series(gateway);
    let isp_series = path_series(isp);
    let path_verdict = |p: &Option<(Vec<(i64, Option<f64>)>, f64)>, start: i64, end: i64| -> Option<bool> {
        let (s, base) = p.as_ref()?;
        let w: Vec<(i64, Option<f64>)> = s.iter().filter(|x| x.0 >= start && x.0 <= end).cloned().collect();
        if w.len() < EPISODE_MIN_WINDOW {
            None
        } else {
            Some(is_degraded_with(&w, *base, PATH_RATIO, PATH_MIN_DELTA_MS))
        }
    };

    degraded_runs(&series, baseline)
        .into_iter()
        .map(|(a, b)| {
            let slice = &series[a..=b];
            let (start, end) = (slice[0].0, slice[slice.len() - 1].0);
            let lost = slice.iter().filter(|s| s.1.is_none()).count();
            let loss_pct = round1(lost as f64 / slice.len() as f64 * 100.0);
            let answered: Vec<f64> = slice.iter().filter_map(|s| s.1).collect();
            let peak_rtt = answered.iter().copied().reduce(f64::max).map(round1);
            let slow = median(answered).map(|m| m > (baseline * DEGRADE_RATIO).max(baseline + DEGRADE_MIN_DELTA_MS)).unwrap_or(false);
            let kind = match (loss_pct >= EPISODE_LOSS_FRAC * 100.0, slow) {
                (true, true) => "mista",
                (true, false) => "perda",
                _ => "latencia",
            };

            // Did the other answering targets degrade over the same interval?
            let verdicts: Vec<bool> = others
                .iter()
                .filter_map(|(s, base)| {
                    let w: Vec<(i64, Option<f64>)> = s.iter().filter(|x| x.0 >= start && x.0 <= end).cloned().collect();
                    if w.len() < EPISODE_MIN_WINDOW {
                        None
                    } else {
                        Some(is_degraded(&w, *base))
                    }
                })
                .collect();
            let scope = if verdicts.is_empty() {
                "unknown"
            } else if verdicts.iter().all(|d| *d) {
                "all-targets"
            } else if verdicts.iter().all(|d| !*d) {
                "primary-only"
            } else {
                "unknown"
            };

            let route_hairpin = routes
                .iter()
                .any(|r| r.hairpin && r.ts >= start - ROUTE_WINDOW_SECS && r.ts <= end + ROUTE_WINDOW_SECS);

            let cause = attribute_cause(
                path_verdict(&gateway_series, start, end),
                path_verdict(&isp_series, start, end),
                scope,
            );

            Episode {
                start,
                end,
                duration_min: ((end - start) as f64 / 60.0).ceil() as i64,
                kind: kind.to_string(),
                peak_rtt,
                loss_pct,
                scope: scope.to_string(),
                route_hairpin,
                cause: cause.to_string(),
            }
        })
        .collect()
}

fn hours_range(hours: &[u8]) -> String {
    // contiguous local hours -> "20h-23h" style ranges
    let mut sorted: Vec<u8> = hours.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut parts = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        let mut end = start;
        while i + 1 < sorted.len() && sorted[i + 1] == end + 1 {
            end = sorted[i + 1];
            i += 1;
        }
        parts.push(format!("{:02}h–{:02}h", start, (end + 1) % 24));
        i += 1;
    }
    parts.join(", ")
}

fn insight(id: &str, severity: &str, title: String, detail: String, suggestion: Option<&str>) -> Insight {
    Insight {
        id: id.into(),
        severity: severity.into(),
        title,
        detail,
        suggestion: suggestion.map(String::from),
    }
}

pub fn analyze(inputs: &Inputs, p: Params) -> Report {
    let since = p.now - p.window_days * 86_400;
    let hours: Vec<HourRow> = inputs.hours.iter().filter(|h| h.hour_ts >= since).cloned().collect();
    let quality = target_quality(&hours);
    let primary = choose_primary(&quality);

    let primary_rows: Vec<&HourRow> = primary
        .as_deref()
        .map(|id| hours.iter().filter(|h| h.target_id == id).collect())
        .unwrap_or_default();

    let coverage_hours = primary_rows.len() as i64;
    let confidence = match coverage_hours {
        h if h < 24 => "insufficient",
        h if h < 72 => "low",
        h if h < 168 => "medium",
        _ => "high",
    };

    let profile_weekday = build_profile(&primary_rows, p.tz_offset_min, false);
    let profile_weekend = build_profile(&primary_rows, p.tz_offset_min, true);
    let mut peak_hours = find_peaks(&profile_weekday, "weekday");
    peak_hours.extend(find_peaks(&profile_weekend, "weekend"));

    let baseline_p50 = median(primary_rows.iter().filter_map(|r| r.p50).collect()).map(round1);

    let episodes = match (&primary, baseline_p50) {
        (Some(id), Some(base)) => {
            let others: Vec<String> = quality
                .iter()
                .filter(|q| q.status == "ok" && &q.id != id && q.id != GATEWAY_ID && q.id != ISP_ID)
                .map(|q| q.id.clone())
                .collect();
            let raw: Vec<RawSample> = inputs.raw.iter().filter(|s| s.ts >= since).cloned().collect();
            let routes: Vec<RouteRow> = inputs.routes.iter().filter(|r| r.ts >= since).cloned().collect();
            let usable = |want: &'static str| -> Option<&'static str> {
                quality.iter().any(|q| q.id == want && (q.status == "ok" || q.status == "flaky")).then_some(want)
            };
            find_episodes(&raw, &routes, id, base, &others, usable(GATEWAY_ID), usable(ISP_ID))
        }
        _ => vec![],
    };

    let mut insights: Vec<Insight> = Vec::new();

    // Data sufficiency
    if confidence == "insufficient" || confidence == "low" {
        insights.push(insight(
            "data-coverage",
            "info",
            "Ainda coletando dados".into(),
            format!(
                "Há {coverage_hours} h de histórico para o alvo principal. A análise por horário fica confiável com cerca de 7 dias de uso."
            ),
            Some("Deixe o app aberto ou na bandeja para acelerar a coleta."),
        ));
    }

    if primary.is_none() && !quality.is_empty() {
        insights.push(insight(
            "no-primary",
            "warn",
            "Nenhum servidor xCloud respondeu".into(),
            "Os alvos de entrada do xCloud não responderam a ICMP/TCP no período analisado.".into(),
            Some("Verifique a conexão e o bloqueio de ICMP/443 no roteador ou firewall."),
        ));
    }

    // Peak hours (need data across several days)
    for group in ["weekday", "weekend"] {
        let peaks: Vec<&PeakHour> = peak_hours.iter().filter(|x| x.group == group).collect();
        if peaks.is_empty() {
            continue;
        }
        let hours: Vec<u8> = peaks.iter().map(|x| x.hour).collect();
        let worst = peaks.iter().map(|x| x.delta_ms).fold(0.0, f64::max);
        let baseline = peaks[0].baseline;
        let label = if group == "weekday" { "dias úteis" } else { "fins de semana" };
        insights.push(insight(
            &format!("peak-{group}"),
            "warn",
            format!("Latência sobe em {}: {label}", hours_range(&hours)),
            format!(
                "Nessa faixa a latência mediana passa de {baseline:.1} ms para até {:.1} ms (+{worst:.1} ms).",
                baseline + worst
            ),
            Some("Se possível jogue fora dessa faixa. Se o padrão se repete todo dia, é congestionamento no horário nobre: guarde estes números para o suporte da operadora."),
        ));
    }

    // Loss, jitter over the analysed window (primary target)
    if !primary_rows.is_empty() {
        let n: i64 = primary_rows.iter().map(|r| r.n).sum();
        let lost: i64 = primary_rows.iter().map(|r| r.n_lost).sum();
        let loss_pct = if n > 0 { lost as f64 / n as f64 * 100.0 } else { 0.0 };
        if loss_pct >= LOSS_WARN_PCT {
            let sev = if loss_pct >= LOSS_CRIT_PCT { "critical" } else { "warn" };
            insights.push(insight(
                "loss",
                sev,
                format!("Perda de pacotes de {loss_pct:.1}% até o xCloud"),
                format!("{lost} de {n} sondagens ficaram sem resposta no período."),
                Some("Prefira cabo de rede ao Wi-Fi e reinicie o roteador; se a perda persistir no cabo, o problema está no acesso da operadora."),
            ));
        }
        let jit: Vec<f64> = primary_rows.iter().filter_map(|r| r.jitter).collect();
        if let Some(j) = mean(&jit) {
            if j >= JITTER_WARN_MS {
                insights.push(insight(
                    "jitter",
                    "warn",
                    format!("Jitter médio alto: {j:.1} ms"),
                    "A variação entre respostas consecutivas está acima de 8 ms, o que causa engasgos na imagem e nos comandos.".into(),
                    Some("Use cabo ou Wi-Fi 5/6 GHz e evite downloads simultâneos durante o jogo."),
                ));
            }
        }
    }

    // Episodes
    if !episodes.is_empty() {
        let total: i64 = episodes.iter().map(|e| e.duration_min).sum();
        let all = episodes.iter().filter(|e| e.scope == "all-targets").count();
        let only = episodes.iter().filter(|e| e.scope == "primary-only").count();
        let hairpin = episodes.iter().filter(|e| e.route_hairpin).count();
        insights.push(insight(
            "episodes",
            if episodes.len() >= 3 { "warn" } else { "info" },
            format!("{} episódio(s) de degradação, {total} min no total", episodes.len()),
            format!(
                "{all} afetaram todos os alvos ao mesmo tempo (acesso local ou da operadora), {only} só o xCloud (trecho até a Microsoft), {hairpin} coincidiram com desvio de rota para os EUA."
            ),
            if all > only {
                Some("Quedas que atingem todos os alvos apontam para Wi-Fi, roteador ou operadora; teste no cabo para separar.")
            } else {
                None
            },
        ));
    }

    // Path comparison: router vs first ISP hop vs xCloud, overall and during the bad episodes
    let during = |id: &str| -> Option<WindowStats> {
        let v: Vec<Option<f64>> = episodes
            .iter()
            .flat_map(|e| inputs.raw.iter().filter(move |s| s.ts >= e.start && s.ts <= e.end))
            .filter(|s| s.target_id == id)
            .map(|s| s.rtt)
            .collect();
        if v.len() < EPISODE_MIN_WINDOW {
            None
        } else {
            Some(window_stats(&v))
        }
    };
    let mut path_comparison: Vec<SegmentStats> = Vec::new();
    let mut seg_of = |role: &str, label: &str, id: &str| {
        if let Some(q) = quality.iter().find(|q| q.id == id) {
            path_comparison.push(SegmentStats {
                role: role.into(),
                label: label.into(),
                id: id.into(),
                samples: q.samples,
                answer_rate: q.answer_rate,
                p50: q.p50,
                p95: q.p95,
                jitter: q.jitter,
                loss_pct: round1((1.0 - q.answer_rate) * 100.0),
                during_episodes: during(id),
            });
        }
    };
    seg_of("local_gateway", "Seu roteador (gateway)", GATEWAY_ID);
    seg_of("isp_hop1", "Primeiro salto do ISP", ISP_ID);
    if let Some(id) = primary.as_deref() {
        seg_of("xcloud", "Servidor xCloud", id);
    }

    // Is the user's own network clean? This is the statement an ISP will ask evidence for.
    let gw_hours = hours.iter().filter(|h| h.target_id == GATEWAY_ID).count();
    if let Some(gw) = quality.iter().find(|q| q.id == GATEWAY_ID) {
        if gw_hours >= LOCAL_MIN_HOURS {
            let p95 = gw.p95.unwrap_or(0.0);
            let loss = (1.0 - gw.answer_rate) * 100.0;
            if gw.answer_rate >= LOCAL_CLEAN_ANSWER_RATE && p95 <= LOCAL_CLEAN_P95_MS {
                insights.push(insight(
                    "local-clean",
                    "info",
                    "Sua rede local está limpa".into(),
                    format!("O roteador respondeu em {:.1}% das sondagens, com p95 de {p95:.1} ms (perda {loss:.2}%) em {gw_hours} h de coleta.", gw.answer_rate * 100.0),
                    Some("Estes números descartam Wi-Fi e roteador como causa; use-os junto ao relatório ao falar com o ISP."),
                ));
            } else if gw.answer_rate < LOCAL_BAD_ANSWER_RATE || p95 > LOCAL_BAD_P95_MS {
                insights.push(insight(
                    "local-problem",
                    "warn",
                    "Há instabilidade na sua rede local".into(),
                    format!("O roteador respondeu em {:.1}% das sondagens, com p95 de {p95:.1} ms.", gw.answer_rate * 100.0),
                    Some("Teste com cabo no lugar do Wi-Fi e reinicie o roteador antes de acionar o ISP, ou o suporte vai apontar para a sua rede."),
                ));
            }
        } else {
            insights.push(insight(
                "local-unverified",
                "info",
                "Rede local ainda não verificada".into(),
                format!("Só há {gw_hours} h de dados do roteador; são necessárias {LOCAL_MIN_HOURS} h para afirmar que a rede local está limpa."),
                None,
            ));
        }
    }
    if let Some(isp) = quality.iter().find(|q| q.id == ISP_ID) {
        if isp.status == "unreachable" && isp.samples >= MIN_SAMPLES_TO_DROP {
            insights.push(insight(
                "isp-hop-silent",
                "info",
                "O primeiro salto do ISP não responde a ping".into(),
                "Sem esse ponto não dá para separar problema no acesso da operadora de problema mais adiante na rede dela.".into(),
                None,
            ));
        }
    }

    // Where do the bad episodes start?
    if !episodes.is_empty() {
        let count = |c: &str| episodes.iter().filter(|e| e.cause == c).count();
        let (local, access, core, beyond, ms, unknown) = (
            count("local"),
            count("isp-access"),
            count("isp-core"),
            count("beyond-local"),
            count("microsoft-path"),
            count("unknown"),
        );
        let outside = access + core + beyond;
        if local > 0 {
            insights.push(insight(
                "cause-local",
                "warn",
                format!("{local} episódio(s) começaram na sua rede local"),
                "O roteador também degradou durante esses episódios.".into(),
                Some("Resolva primeiro: cabo em vez de Wi-Fi, reiniciar o roteador, remover interferência."),
            ));
        }
        if outside > 0 {
            insights.push(insight(
                "cause-isp",
                "warn",
                format!("{outside} episódio(s) começaram fora da sua rede local"),
                format!(
                    "Com o roteador estável: {access} no acesso da operadora (1º salto), {core} no núcleo dela, {beyond} adiante do roteador sem dado do 1º salto."
                ),
                Some("Gere o relatório de evidência e envie ao ISP: ele mostra o roteador estável enquanto o resto degrada."),
            ));
        }
        if ms > 0 {
            insights.push(insight(
                "cause-microsoft",
                "info",
                format!("{ms} episódio(s) só no caminho até o xCloud"),
                "Os outros alvos ficaram normais; o problema está entre a operadora e a Microsoft ou na própria região de streaming.".into(),
                None,
            ));
        }
        if unknown > 0 && local + outside + ms == 0 {
            insights.push(insight(
                "cause-unknown",
                "info",
                format!("{unknown} episódio(s) sem causa atribuída"),
                "Faltam dados do roteador ou de outros alvos nesses intervalos.".into(),
                None,
            ));
        }
    }

    // Route runs
    let routes: Vec<&RouteRow> = inputs.routes.iter().filter(|r| r.ts >= since).collect();
    if routes.len() >= 3 {
        let hp = routes.iter().filter(|r| r.hairpin).count();
        let share = hp as f64 / routes.len() as f64;
        if share >= HAIRPIN_WARN_SHARE {
            let pop = routes.iter().find_map(|r| r.detected_pop.clone()).unwrap_or_else(|| "os EUA".into());
            insights.push(insight(
                "hairpin",
                "critical",
                format!("Rota desviada para {pop} em {hp} de {} medições", routes.len()),
                "O tráfego até São Paulo saiu do Brasil. Isso dobra a latência e é decidido pela operadora, não pelo seu equipamento.".into(),
                Some("Abra chamado na operadora citando o AS8075 (Microsoft) e anexe o CSV exportado."),
            ));
        }
    }

    // Bufferbloat tests
    let bloats: Vec<&BloatRow> = inputs.bloats.iter().filter(|b| b.ts >= since).collect();
    if bloats.len() >= 2 {
        let bad = bloats.iter().filter(|b| b.delta >= BLOAT_BAD_MS).count();
        if bad as f64 / bloats.len() as f64 >= 0.3 {
            insights.push(insight(
                "bufferbloat",
                "warn",
                format!("Bufferbloat alto em {bad} de {} testes", bloats.len()),
                "A latência sobe 40 ms ou mais quando a linha está ocupada.".into(),
                Some("Ative SQM/QoS (fq_codel ou CAKE) no roteador ou limite a banda em ~90% da contratada."),
            ));
        }
    }

    // Target hygiene
    let dead: Vec<&TargetQuality> =
        quality
            .iter()
            .filter(|q| q.status == "unreachable" && q.samples >= MIN_SAMPLES_TO_DROP && q.id != GATEWAY_ID && q.id != ISP_ID)
            .collect();
    if !dead.is_empty() {
        let names: Vec<&str> = dead.iter().map(|q| q.id.as_str()).collect();
        insights.push(insight(
            "dead-targets",
            "info",
            format!("{} alvo(s) nunca respondem", dead.len()),
            format!("Sem resposta em mais de 95% das sondagens: {}.", names.join(", ")),
            Some("Estes alvos bloqueiam ICMP e TCP; vale removê-los ou trocá-los por outros que respondam."),
        ));
    }

    Report {
        generated_at: p.now,
        window_days: p.window_days,
        coverage_hours,
        confidence: confidence.to_string(),
        primary_target: primary,
        baseline_p50,
        targets: quality,
        profile_weekday,
        profile_weekend,
        peak_hours,
        episodes,
        path_comparison,
        insights,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;
    const BASE: i64 = 20_000 * DAY; // a Sunday? checked in test below via local_parts

    fn hour_row(ts: i64, id: &str, p50: f64, lost: i64) -> HourRow {
        HourRow {
            hour_ts: ts,
            target_id: id.into(),
            n: 120,
            n_lost: lost,
            p50: Some(p50),
            p95: Some(p50 + 8.0),
            jitter: Some(2.0),
        }
    }

    /// `days` days of hourly rows with an evening bump (20h-22h local) on a weekday-heavy range.
    fn synthetic_hours(days: i64, tz: i32) -> Vec<HourRow> {
        let mut rows = Vec::new();
        for d in 0..days {
            for h in 0..24 {
                let ts = BASE + d * DAY + h * 3600;
                let (local_hour, _, _) = local_parts(ts, tz);
                let p50 = if (20..=22).contains(&local_hour) { 62.0 } else { 36.0 };
                rows.push(hour_row(ts, "xcloud_gssv_prod", p50, 0));
                rows.push(hour_row(ts, "ix_sp_v4_2", p50 - 5.0, 0));
                rows.push(hour_row(ts, "ix_rj", 0.0, 120)); // never answers
            }
        }
        rows.iter_mut().filter(|r| r.target_id == "ix_rj").for_each(|r| {
            r.p50 = None;
            r.p95 = None;
            r.jitter = None;
        });
        rows
    }

    fn params(days: i64) -> Params {
        Params { now: BASE + days * DAY, tz_offset_min: -180, window_days: days }
    }

    #[test]
    fn local_parts_handles_timezone_and_weekday() {
        // 1970-01-01 00:00 UTC is Thursday; at -3h it is Wednesday 21:00
        let (hour, _, weekend) = local_parts(0, -180);
        assert_eq!(hour, 21);
        assert!(!weekend);
        // 1970-01-03 12:00 UTC is Saturday
        assert!(local_parts(2 * DAY + 12 * 3600, 0).2);
    }

    #[test]
    fn classifies_targets_and_picks_primary() {
        let hours = synthetic_hours(3, -180);
        let q = target_quality(&hours);
        let by = |id: &str| q.iter().find(|x| x.id == id).unwrap();
        assert_eq!(by("xcloud_gssv_prod").status, "ok");
        assert_eq!(by("ix_rj").status, "unreachable");
        assert_eq!(choose_primary(&q).as_deref(), Some("xcloud_gssv_prod"));
    }

    #[test]
    fn finds_evening_peak_with_enough_days() {
        let hours = synthetic_hours(14, -180);
        let report = analyze(&Inputs { hours: &hours, raw: &[], routes: &[], bloats: &[] }, params(14));
        let wd: Vec<u8> = report.peak_hours.iter().filter(|x| x.group == "weekday").map(|x| x.hour).collect();
        assert_eq!(wd, vec![20, 21, 22]);
        assert_eq!(report.baseline_p50, Some(36.0));
        assert_eq!(report.confidence, "high");
        let ins = report.insights.iter().find(|i| i.id == "peak-weekday").unwrap();
        assert!(ins.title.contains("20h–23h"), "{}", ins.title);
        assert!(ins.detail.contains("36.0") && ins.detail.contains("62.0"));
    }

    #[test]
    fn little_data_means_no_peaks_and_a_coverage_notice() {
        let hours = synthetic_hours(1, -180);
        let report = analyze(&Inputs { hours: &hours, raw: &[], routes: &[], bloats: &[] }, params(1));
        assert!(report.peak_hours.is_empty());
        assert_eq!(report.confidence, "low"); // exactly 24 h of coverage
        assert!(report.insights.iter().any(|i| i.id == "data-coverage"));
    }

    #[test]
    fn reports_dead_targets_only_with_enough_samples() {
        let hours = synthetic_hours(3, -180); // 3*24*120 = 8640 samples for ix_rj
        let r = analyze(&Inputs { hours: &hours, raw: &[], routes: &[], bloats: &[] }, params(3));
        assert!(r.insights.iter().any(|i| i.id == "dead-targets" && i.detail.contains("ix_rj")));

        let few = vec![hour_row(BASE, "ix_rj", 0.0, 120)]; // 120 samples < 200
        let r = analyze(&Inputs { hours: &few, raw: &[], routes: &[], bloats: &[] }, params(1));
        assert!(!r.insights.iter().any(|i| i.id == "dead-targets"));
    }

    fn raw_series(id: &str, start: i64, rtts: &[Option<f64>]) -> Vec<RawSample> {
        rtts.iter()
            .enumerate()
            .map(|(i, r)| RawSample { ts: start + i as i64 * 30, target_id: id.into(), rtt: *r })
            .collect()
    }

    fn calm(n: usize, v: f64) -> Vec<Option<f64>> {
        vec![Some(v); n]
    }

    #[test]
    fn detects_episode_affecting_all_targets_and_ignores_short_blips() {
        let start = BASE;
        let mut prim = calm(40, 36.0);
        let mut other = calm(40, 30.0);
        for i in 15..30 {
            prim[i] = Some(140.0);
            other[i] = Some(120.0);
        }
        prim[3] = Some(200.0); // single blip, must not count
        let mut raw = raw_series("xcloud_gssv_prod", start, &prim);
        raw.extend(raw_series("ix_sp_v4_2", start, &other));
        let others = vec!["ix_sp_v4_2".to_string()];

        let eps = find_episodes(&raw, &[], "xcloud_gssv_prod", 36.0, &others, None, None);
        assert_eq!(eps.len(), 1, "{eps:?}");
        assert_eq!(eps[0].scope, "all-targets");
        assert_eq!(eps[0].kind, "latencia");
        assert!(eps[0].duration_min >= 3);
        assert_eq!(eps[0].peak_rtt, Some(140.0));
    }

    #[test]
    fn episode_only_on_primary_and_hairpin_correlation() {
        let start = BASE;
        let mut prim = calm(40, 36.0);
        for i in 10..25 {
            prim[i] = Some(150.0);
        }
        let mut raw = raw_series("xcloud_gssv_prod", start, &prim);
        raw.extend(raw_series("ix_sp_v4_2", start, &calm(40, 30.0)));
        let routes = vec![RouteRow { ts: start + 300, hairpin: true, detected_pop: Some("Miami (EUA)".into()) }];
        let eps = find_episodes(&raw, &routes, "xcloud_gssv_prod", 36.0, &["ix_sp_v4_2".to_string()], None, None);
        assert_eq!(eps.len(), 1);
        assert_eq!(eps[0].scope, "primary-only");
        assert!(eps[0].route_hairpin);
    }

    #[test]
    fn packet_loss_episode_is_typed_as_loss() {
        let mut prim = calm(40, 36.0);
        for i in 10..22 {
            prim[i] = None;
        }
        let raw = raw_series("xcloud_gssv_prod", BASE, &prim);
        let eps = find_episodes(&raw, &[], "xcloud_gssv_prod", 36.0, &[], None, None);
        assert_eq!(eps.len(), 1);
        assert_eq!(eps[0].kind, "perda");
        assert_eq!(eps[0].scope, "unknown"); // nothing to compare against
        assert!(eps[0].loss_pct >= 20.0);
    }

    #[test]
    fn app_off_gap_does_not_create_an_episode() {
        let mut raw = raw_series("xcloud_gssv_prod", BASE, &calm(20, 36.0));
        // 10 hours later the app resumes with a normal series
        raw.extend(raw_series("xcloud_gssv_prod", BASE + 36_000, &calm(20, 36.0)));
        let eps = find_episodes(&raw, &[], "xcloud_gssv_prod", 36.0, &[], None, None);
        assert!(eps.is_empty());
        assert_eq!(segment_ranges(&series_for(&raw, "xcloud_gssv_prod")).len(), 2);
    }

    #[test]
    fn route_and_bufferbloat_insights_need_minimum_runs() {
        let hours = synthetic_hours(3, -180);
        let routes: Vec<RouteRow> = (0..4)
            .map(|i| RouteRow { ts: BASE + DAY + i * 600, hairpin: i < 2, detected_pop: Some("Miami (EUA)".into()) })
            .collect();
        let bloats = vec![BloatRow { ts: BASE + DAY, delta: 55.0 }, BloatRow { ts: BASE + DAY + 5, delta: 62.0 }];
        let r = analyze(&Inputs { hours: &hours, raw: &[], routes: &routes, bloats: &bloats }, params(3));
        let h = r.insights.iter().find(|i| i.id == "hairpin").unwrap();
        assert_eq!(h.severity, "critical");
        assert!(h.title.contains("Miami") && h.title.contains("2 de 4"));
        assert!(r.insights.iter().any(|i| i.id == "bufferbloat"));

        let one = vec![RouteRow { ts: BASE + DAY, hairpin: true, detected_pop: None }];
        let r = analyze(&Inputs { hours: &hours, raw: &[], routes: &one, bloats: &[] }, params(3));
        assert!(!r.insights.iter().any(|i| i.id == "hairpin"));
    }

    #[test]
    fn loss_insight_severity_scales() {
        let mut hours = synthetic_hours(3, -180);
        hours.iter_mut().filter(|h| h.target_id == "xcloud_gssv_prod").for_each(|h| h.n_lost = 10); // 8.3%
        let r = analyze(&Inputs { hours: &hours, raw: &[], routes: &[], bloats: &[] }, params(3));
        assert_eq!(r.insights.iter().find(|i| i.id == "loss").unwrap().severity, "critical");
    }

    #[test]
    fn hours_range_merges_contiguous_hours() {
        assert_eq!(hours_range(&[20, 21, 22]), "20h–23h");
        assert_eq!(hours_range(&[9, 20, 21]), "09h–10h, 20h–22h");
        assert_eq!(hours_range(&[23]), "23h–00h");
    }

    /// Episode on the primary target with configurable health of router / first ISP hop / other target.
    fn episode_causes(gw_bad: bool, isp_bad: bool, others_bad: bool, with_path: bool) -> Vec<Episode> {
        let series = |calm: f64, bad: f64, is_bad: bool| -> Vec<Option<f64>> {
            let mut v = calm_series(40, calm);
            if is_bad {
                for i in 15..30 {
                    v[i] = Some(bad);
                }
            }
            v
        };
        let mut raw = raw_series("xcloud_gssv_prod", BASE, &series(36.0, 140.0, true));
        raw.extend(raw_series("ix_sp_v4_2", BASE, &series(30.0, 120.0, others_bad)));
        raw.extend(raw_series(GATEWAY_ID, BASE, &series(0.5, 30.0, gw_bad)));
        raw.extend(raw_series(ISP_ID, BASE, &series(15.0, 80.0, isp_bad)));
        let (gw, isp) = if with_path { (Some(GATEWAY_ID), Some(ISP_ID)) } else { (None, None) };
        find_episodes(&raw, &[], "xcloud_gssv_prod", 36.0, &["ix_sp_v4_2".to_string()], gw, isp)
    }

    fn calm_series(n: usize, v: f64) -> Vec<Option<f64>> {
        vec![Some(v); n]
    }

    #[test]
    fn attributes_cause_from_router_and_first_isp_hop() {
        let cause = |gw, isp, others, path| {
            let eps = episode_causes(gw, isp, others, path);
            assert_eq!(eps.len(), 1, "{eps:?}");
            eps[0].cause.clone()
        };
        assert_eq!(cause(true, true, true, true), "local");
        assert_eq!(cause(false, true, true, true), "isp-access");
        assert_eq!(cause(false, false, true, true), "isp-core");
        assert_eq!(cause(false, false, false, true), "microsoft-path");
        assert_eq!(cause(false, true, true, false), "unknown"); // router not measured: no claim
    }

    fn gateway_rows(hours: i64, p95: f64, lost_per_hour: i64) -> Vec<HourRow> {
        (0..hours)
            .map(|h| HourRow {
                hour_ts: BASE + h * 3600,
                target_id: GATEWAY_ID.into(),
                n: 120,
                n_lost: lost_per_hour,
                p50: Some(0.5),
                p95: Some(p95),
                jitter: Some(0.2),
            })
            .collect()
    }

    #[test]
    fn local_network_verdict_needs_a_day_of_data_and_real_numbers() {
        let base = synthetic_hours(3, -180);
        let run = |gw: Vec<HourRow>| {
            let mut hours = base.clone();
            hours.extend(gw);
            analyze(&Inputs { hours: &hours, raw: &[], routes: &[], bloats: &[] }, params(3))
        };
        let ids = |r: &Report| r.insights.iter().map(|i| i.id.clone()).collect::<Vec<_>>();

        assert!(ids(&run(gateway_rows(48, 1.2, 0))).contains(&"local-clean".to_string()));
        assert!(ids(&run(gateway_rows(10, 1.2, 0))).contains(&"local-unverified".to_string()));
        assert!(ids(&run(gateway_rows(48, 22.0, 0))).contains(&"local-problem".to_string()));
        assert!(ids(&run(gateway_rows(48, 1.2, 3))).contains(&"local-problem".to_string())); // 2.5% loss

        let r = run(gateway_rows(48, 1.2, 0));
        let roles: Vec<&str> = r.path_comparison.iter().map(|s| s.role.as_str()).collect();
        assert_eq!(roles, vec!["local_gateway", "xcloud"]);
        assert_eq!(r.path_comparison[0].loss_pct, 0.0);
    }

    #[test]
    fn path_probes_are_never_reported_as_dead_targets() {
        let mut hours = synthetic_hours(3, -180);
        hours.extend(gateway_rows(72, 1.0, 120)); // router "never answers"
        let r = analyze(&Inputs { hours: &hours, raw: &[], routes: &[], bloats: &[] }, params(3));
        let dead = r.insights.iter().find(|i| i.id == "dead-targets").unwrap();
        assert!(!dead.detail.contains(GATEWAY_ID));
    }
}
