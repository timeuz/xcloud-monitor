//! Local measurement history (SQLite) and the background sampler that feeds it.
//!
//! Everything stays on the user's machine, in the app data directory. Only real measurements are
//! stored: a probe that got no answer is stored as `NULL`, never as a made-up value.
//!
//! Retention: raw samples for 14 days, hourly roll-ups (count, loss, avg/min/max/p50/p95, jitter)
//! for 365 days, route and bufferbloat runs for 365 days.

use crate::analysis::{self, BloatRow, HourRow, Inputs, Params, RawSample, Report, RouteRow};
use crate::bufferbloat::BufferbloatResponse;
use crate::network::{self, StrategicEndpoint};
use crate::report::{self, BloatDetail, Extras, HopRow, Meta, RouteRunDetail};
use crate::route::{self, TracerouteResponse};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(30);
const ROUTE_EVERY_CYCLES: u64 = 10; // 5 minutes
const MAINTENANCE_EVERY_CYCLES: u64 = 120; // 1 hour
const RAW_RETENTION_SECS: i64 = 14 * 24 * 3600;
const AGGREGATE_RETENTION_SECS: i64 = 365 * 24 * 3600;
const HOUR: i64 = 3600;

const SCHEMA_VERSION: i32 = 2;
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    rtt_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
CREATE INDEX IF NOT EXISTS idx_samples_target_ts ON samples(target_id, ts);
CREATE TABLE IF NOT EXISTS hourly (
    hour_ts INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    n_lost INTEGER NOT NULL,
    rtt_avg REAL,
    rtt_min REAL,
    rtt_max REAL,
    rtt_p50 REAL,
    rtt_p95 REAL,
    jitter_avg REAL,
    PRIMARY KEY (hour_ts, target_id)
);
CREATE TABLE IF NOT EXISTS route_runs (
    ts INTEGER PRIMARY KEY,
    hairpin INTEGER NOT NULL,
    hop_count INTEGER NOT NULL,
    reached INTEGER NOT NULL,
    detected_pop TEXT,
    source TEXT,
    evidence TEXT,
    hops_json TEXT
);
CREATE TABLE IF NOT EXISTS bufferbloat_runs (
    ts INTEGER PRIMARY KEY,
    idle_rtt REAL NOT NULL,
    loaded_rtt REAL NOT NULL,
    delta REAL NOT NULL,
    status TEXT NOT NULL,
    down_mbps REAL,
    up_mbps REAL,
    delta_down REAL,
    delta_up REAL,
    grade TEXT
);
";

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct HourStats {
    pub n: i64,
    pub n_lost: i64,
    pub avg: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub jitter: Option<f64>,
}

/// Nearest-rank percentile over an ascending-sorted slice.
fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil().max(1.0) as usize;
    Some(sorted[rank.min(sorted.len()) - 1])
}

/// Summarises one target-hour of raw samples (in chronological order; `None` = no answer).
pub fn summarize(samples: &[Option<f64>]) -> HourStats {
    let ok: Vec<f64> = samples.iter().filter_map(|s| *s).collect();
    let mut sorted = ok.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    // Jitter: mean absolute difference between consecutive answered samples (RFC 3550 style).
    let jitter = if ok.len() >= 2 {
        let total: f64 = ok.windows(2).map(|w| (w[1] - w[0]).abs()).sum();
        Some(total / (ok.len() - 1) as f64)
    } else {
        None
    };

    HourStats {
        n: samples.len() as i64,
        n_lost: (samples.len() - ok.len()) as i64,
        avg: if ok.is_empty() { None } else { Some(ok.iter().sum::<f64>() / ok.len() as f64) },
        min: sorted.first().copied(),
        max: sorted.last().copied(),
        p50: percentile(&sorted, 50.0),
        p95: percentile(&sorted, 95.0),
        jitter,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStats {
    pub enabled: bool,
    pub sample_count: i64,
    pub hourly_count: i64,
    pub route_runs: i64,
    pub bufferbloat_runs: i64,
    pub oldest_ts: Option<i64>,
    pub newest_ts: Option<i64>,
    pub db_bytes: u64,
    pub interval_secs: u64,
    pub raw_retention_days: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPoint {
    pub ts: i64,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub loss_pct: f64,
    pub n: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub id: String,
    /// local_gateway | isp_hop1 | xcloud
    pub role: String,
    pub label: String,
    pub points: Vec<SeriesPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteMark {
    pub ts: i64,
    pub hairpin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BloatMark {
    pub ts: i64,
    pub delta: f64,
    pub grade: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesResponse {
    pub from: i64,
    pub to: i64,
    pub bucket_secs: i64,
    pub series: Vec<Series>,
    pub routes: Vec<RouteMark>,
    pub bloats: Vec<BloatMark>,
}

/// About 240 buckets across the window, in whole minutes.
pub fn bucket_for_window(window_secs: i64) -> i64 {
    let raw = (window_secs + 239) / 240;
    (((raw + 59) / 60) * 60).max(60)
}

pub struct History {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl History {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(conn, path.to_path_buf())
    }

    /// Non-persistent fallback used when the database file cannot be opened.
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::init(conn, PathBuf::new())
    }

    fn init(conn: Connection, path: PathBuf) -> Result<Self, String> {
        let _: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
            .unwrap_or_default();
        conn.execute_batch("PRAGMA synchronous=NORMAL;").map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        // Targets retired from the probe list only ever hold unanswered or duplicate rows: drop them.
        for table in ["samples", "hourly"] {
            let placeholders = vec!["?"; network::RETIRED_TARGETS.len()].join(",");
            let _ = conn.execute(
                &format!("DELETE FROM {table} WHERE target_id IN ({placeholders})"),
                rusqlite::params_from_iter(network::RETIRED_TARGETS.iter()),
            );
        }
        // v2 added columns; CREATE TABLE IF NOT EXISTS does not touch existing tables, so add them
        // explicitly. A duplicate-column error just means the table is already current.
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
        if version < 2 {
            for sql in [
                "ALTER TABLE route_runs ADD COLUMN hops_json TEXT",
                "ALTER TABLE bufferbloat_runs ADD COLUMN down_mbps REAL",
                "ALTER TABLE bufferbloat_runs ADD COLUMN up_mbps REAL",
                "ALTER TABLE bufferbloat_runs ADD COLUMN delta_down REAL",
                "ALTER TABLE bufferbloat_runs ADD COLUMN delta_up REAL",
                "ALTER TABLE bufferbloat_runs ADD COLUMN grade TEXT",
            ] {
                let _ = conn.execute(sql, []);
            }
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION).map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn), path })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn get_meta(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map(|_| ())
    }

    /// Collection is on by default; the user can turn it off.
    pub fn is_enabled(&self) -> bool {
        Self::get_meta(&self.lock(), "collection_enabled").map(|v| v != "0").unwrap_or(true)
    }

    /// Boolean preference stored in `meta` ("1"/"0"); `default` when never set.
    pub fn meta_flag(&self, key: &str, default: bool) -> bool {
        Self::get_meta(&self.lock(), key).map(|v| v != "0").unwrap_or(default)
    }

    pub fn set_meta_flag(&self, key: &str, value: bool) -> Result<(), String> {
        Self::set_meta(&self.lock(), key, if value { "1" } else { "0" }).map_err(|e| e.to_string())
    }

    /// Closing the window hides it to the tray (default on; only honoured when a tray exists).
    pub fn close_to_tray(&self) -> bool {
        self.meta_flag(crate::desktop::meta_close_to_tray_key(), true)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        Self::set_meta(&self.lock(), "collection_enabled", if enabled { "1" } else { "0" })
            .map_err(|e| e.to_string())
    }

    pub fn record_probe(&self, ts: i64, endpoints: &[StrategicEndpoint]) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare_cached("INSERT INTO samples(ts, target_id, rtt_ms) VALUES(?1, ?2, ?3)")
                .map_err(|e| e.to_string())?;
            for ep in endpoints {
                let rtt = if ep.online { ep.rtt_ms } else { None };
                stmt.execute(params![ts, ep.id, rtt]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn record_route(&self, ts: i64, r: &TracerouteResponse) -> Result<(), String> {
        self.lock()
            .execute(
                "INSERT OR REPLACE INTO route_runs(ts, hairpin, hop_count, reached, detected_pop, source, evidence, hops_json)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    ts,
                    r.is_hairpinning as i64,
                    r.hop_count as i64,
                    r.reached as i64,
                    r.detected_pop,
                    r.source,
                    r.evidence.join(" | "),
                    serde_json::to_string(&r.hops).ok()
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn record_bufferbloat(&self, ts: i64, b: &BufferbloatResponse) -> Result<(), String> {
        self.lock()
            .execute(
                "INSERT OR REPLACE INTO bufferbloat_runs(ts, idle_rtt, loaded_rtt, delta, status, down_mbps, up_mbps, delta_down, delta_up, grade)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    ts,
                    b.idle_rtt,
                    b.loaded_rtt,
                    b.delta_bufferbloat,
                    b.status,
                    b.down_mbps,
                    b.up_mbps,
                    b.delta_down,
                    b.delta_up,
                    b.grade
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Rolls completed hours up into `hourly`, then prunes expired rows.
    pub fn maintenance(&self, now: i64) -> Result<(), String> {
        let current_hour = now - now.rem_euclid(HOUR);
        let mut conn = self.lock();

        let from = Self::get_meta(&conn, "rollup_until")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);

        if from < current_hour {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            let mut groups: BTreeMap<(i64, String), Vec<Option<f64>>> = BTreeMap::new();
            {
                let mut stmt = tx
                    .prepare(
                        "SELECT ts, target_id, rtt_ms FROM samples WHERE ts >= ?1 AND ts < ?2 ORDER BY ts",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![from, current_hour], |r| {
                        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<f64>>(2)?))
                    })
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let (ts, target, rtt) = row.map_err(|e| e.to_string())?;
                    groups.entry((ts - ts.rem_euclid(HOUR), target)).or_default().push(rtt);
                }
            }
            for ((hour_ts, target), samples) in &groups {
                let s = summarize(samples);
                tx.execute(
                    "INSERT OR REPLACE INTO hourly(hour_ts, target_id, n, n_lost, rtt_avg, rtt_min, rtt_max, rtt_p50, rtt_p95, jitter_avg)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![hour_ts, target, s.n, s.n_lost, s.avg, s.min, s.max, s.p50, s.p95, s.jitter],
                )
                .map_err(|e| e.to_string())?;
            }
            Self::set_meta(&tx, "rollup_until", &current_hour.to_string()).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }

        // Raw rows are only pruned once they have been rolled up.
        let rolled = Self::get_meta(&conn, "rollup_until")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        let raw_cutoff = (now - RAW_RETENTION_SECS).min(rolled);
        let agg_cutoff = now - AGGREGATE_RETENTION_SECS;
        conn.execute("DELETE FROM samples WHERE ts < ?1", [raw_cutoff]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM hourly WHERE hour_ts < ?1", [agg_cutoff]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM route_runs WHERE ts < ?1", [agg_cutoff]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM bufferbloat_runs WHERE ts < ?1", [agg_cutoff]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn stats(&self) -> Result<HistoryStats, String> {
        let enabled = self.is_enabled();
        let conn = self.lock();
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap_or(0)
        };
        let (oldest, newest): (Option<i64>, Option<i64>) = conn
            .query_row("SELECT MIN(ts), MAX(ts) FROM samples", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap_or((None, None));
        let db_bytes = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        Ok(HistoryStats {
            enabled,
            sample_count: count("samples"),
            hourly_count: count("hourly"),
            route_runs: count("route_runs"),
            bufferbloat_runs: count("bufferbloat_runs"),
            oldest_ts: oldest,
            newest_ts: newest,
            db_bytes,
            interval_secs: SAMPLE_INTERVAL.as_secs(),
            raw_retention_days: RAW_RETENTION_SECS / (24 * 3600),
        })
    }

    /// Loads what the analysis needs and runs it. Hours not yet rolled up are summarised on the fly
    /// (complete hours only), so the newest data is never missing from the report.
    pub fn analyze(&self, now: i64, tz_offset_min: i32, window_days: i64) -> Result<Report, String> {
        let since = now - window_days * 24 * HOUR;
        let episode_since = now - window_days.min(7) * 24 * HOUR;
        let current_hour = now - now.rem_euclid(HOUR);
        let conn = self.lock();

        let mut hours: Vec<HourRow> = {
            let mut stmt = conn
                .prepare(
                    "SELECT hour_ts, target_id, n, n_lost, rtt_p50, rtt_p95, jitter_avg FROM hourly WHERE hour_ts >= ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([since], |r| {
                    Ok(HourRow {
                        hour_ts: r.get(0)?,
                        target_id: r.get(1)?,
                        n: r.get(2)?,
                        n_lost: r.get(3)?,
                        p50: r.get(4)?,
                        p95: r.get(5)?,
                        jitter: r.get(6)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };

        // complete hours that maintenance has not rolled up yet
        let rolled = Self::get_meta(&conn, "rollup_until").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        let pending_from = rolled.max(since);
        let mut groups: BTreeMap<(i64, String), Vec<Option<f64>>> = BTreeMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT ts, target_id, rtt_ms FROM samples WHERE ts >= ?1 AND ts < ?2 ORDER BY ts")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![pending_from, current_hour], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<f64>>(2)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (ts, target, rtt) = row.map_err(|e| e.to_string())?;
                groups.entry((ts - ts.rem_euclid(HOUR), target)).or_default().push(rtt);
            }
        }
        for ((hour_ts, target_id), samples) in groups {
            let s = summarize(&samples);
            hours.push(HourRow { hour_ts, target_id, n: s.n, n_lost: s.n_lost, p50: s.p50, p95: s.p95, jitter: s.jitter });
        }

        let raw: Vec<RawSample> = {
            let mut stmt = conn
                .prepare("SELECT ts, target_id, rtt_ms FROM samples WHERE ts >= ?1 ORDER BY ts")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([episode_since], |r| Ok(RawSample { ts: r.get(0)?, target_id: r.get(1)?, rtt: r.get(2)? }))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        let routes: Vec<RouteRow> = {
            let mut stmt = conn
                .prepare("SELECT ts, hairpin, detected_pop FROM route_runs WHERE ts >= ?1 ORDER BY ts")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([since], |r| {
                    Ok(RouteRow { ts: r.get(0)?, hairpin: r.get::<_, i64>(1)? != 0, detected_pop: r.get(2)? })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        let bloats: Vec<BloatRow> = {
            let mut stmt = conn
                .prepare("SELECT ts, delta FROM bufferbloat_runs WHERE ts >= ?1 ORDER BY ts")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([since], |r| Ok(BloatRow { ts: r.get(0)?, delta: r.get(1)? }))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        drop(conn);

        Ok(analysis::analyze(
            &Inputs { hours: &hours, raw: &raw, routes: &routes, bloats: &bloats },
            Params { now, tz_offset_min, window_days },
        ))
    }

    /// Route runs (with hops) and bufferbloat tests for the evidence report.
    pub fn evidence_extras(&self, since: i64) -> Result<Extras, String> {
        let stats = self.stats()?;
        let conn = self.lock();
        let routes: Vec<RouteRunDetail> = {
            let mut stmt = conn
                .prepare(
                    "SELECT ts, hairpin, detected_pop, source, hops_json FROM route_runs WHERE ts >= ?1 ORDER BY ts DESC LIMIT 200",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([since], |r| {
                    let json: Option<String> = r.get(4)?;
                    Ok(RouteRunDetail {
                        ts: r.get(0)?,
                        hairpin: r.get::<_, i64>(1)? != 0,
                        detected_pop: r.get(2)?,
                        source: r.get(3)?,
                        hops: json.and_then(|j| serde_json::from_str::<Vec<HopRow>>(&j).ok()).unwrap_or_default(),
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        let bloats: Vec<BloatDetail> = {
            let mut stmt = conn
                .prepare(
                    "SELECT ts, idle_rtt, delta, down_mbps, up_mbps, delta_down, delta_up, grade
                     FROM bufferbloat_runs WHERE ts >= ?1 ORDER BY ts DESC LIMIT 50",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([since], |r| {
                    Ok(BloatDetail {
                        ts: r.get(0)?,
                        idle_rtt: r.get(1)?,
                        delta: r.get(2)?,
                        down_mbps: r.get(3)?,
                        up_mbps: r.get(4)?,
                        delta_down: r.get(5)?,
                        delta_up: r.get(6)?,
                        grade: r.get(7)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        Ok(Extras { routes, bloats, stats })
    }

    /// Time series of the router, first ISP hop and best xCloud entry point, bucketed for charts,
    /// plus route and bufferbloat markers. Empty buckets are omitted (the UI draws them as gaps).
    pub fn series(&self, now: i64, window_secs: i64) -> Result<SeriesResponse, String> {
        let from = now - window_secs;
        let bucket = bucket_for_window(window_secs);
        let conn = self.lock();

        // primary = the xCloud entry point that answered most in the window
        let mut primary: Option<(String, i64)> = None;
        for cand in analysis::PRIMARY_CANDIDATES {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM samples WHERE target_id = ?1 AND ts >= ?2 AND rtt_ms IS NOT NULL",
                    params![cand, from],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if n > 0 && primary.as_ref().map(|p| n > p.1).unwrap_or(true) {
                primary = Some((cand.to_string(), n));
            }
        }

        let mut wanted: Vec<(&str, String, &str)> = vec![
            ("local_gateway", analysis::GATEWAY_ID.to_string(), "Seu roteador"),
            ("isp_hop1", analysis::ISP_ID.to_string(), "1º salto do ISP"),
        ];
        if let Some((id, _)) = primary {
            wanted.push(("xcloud", id, "Servidor xCloud"));
        }

        let mut series = Vec::new();
        for (role, id, label) in wanted {
            let mut stmt = conn
                .prepare("SELECT ts, rtt_ms FROM samples WHERE target_id = ?1 AND ts >= ?2 AND ts <= ?3 ORDER BY ts")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![id, from, now], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<f64>>(1)?)))
                .map_err(|e| e.to_string())?;
            let mut buckets: BTreeMap<i64, Vec<Option<f64>>> = BTreeMap::new();
            for row in rows {
                let (ts, rtt) = row.map_err(|e| e.to_string())?;
                buckets.entry(ts - ts.rem_euclid(bucket)).or_default().push(rtt);
            }
            if buckets.is_empty() {
                continue;
            }
            let points = buckets
                .into_iter()
                .map(|(ts, samples)| {
                    let s = summarize(&samples);
                    SeriesPoint {
                        ts,
                        p50: s.p50,
                        p95: s.p95,
                        loss_pct: if s.n > 0 { (s.n_lost as f64 / s.n as f64 * 1000.0).round() / 10.0 } else { 0.0 },
                        n: s.n,
                    }
                })
                .collect();
            series.push(Series { id, role: role.into(), label: label.into(), points });
        }

        let routes: Vec<RouteMark> = {
            let mut stmt = conn
                .prepare("SELECT ts, hairpin FROM route_runs WHERE ts >= ?1 AND ts <= ?2 ORDER BY ts")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![from, now], |r| Ok(RouteMark { ts: r.get(0)?, hairpin: r.get::<_, i64>(1)? != 0 }))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        let bloats: Vec<BloatMark> = {
            let mut stmt = conn
                .prepare("SELECT ts, delta, grade FROM bufferbloat_runs WHERE ts >= ?1 AND ts <= ?2 ORDER BY ts")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![from, now], |r| Ok(BloatMark { ts: r.get(0)?, delta: r.get(1)?, grade: r.get(2)? }))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };

        Ok(SeriesResponse { from, to: now, bucket_secs: bucket, series, routes, bloats })
    }

    /// Deletes every stored measurement (the collection on/off preference is kept).
    pub fn clear(&self) -> Result<(), String> {
        let conn = self.lock();
        conn.execute_batch(
            "DELETE FROM samples; DELETE FROM hourly; DELETE FROM route_runs; DELETE FROM bufferbloat_runs;
             DELETE FROM meta WHERE key = 'rollup_until'; VACUUM;",
        )
        .map_err(|e| e.to_string())
    }

    /// Writes raw samples as CSV: `ts_unix,target_id,rtt_ms` (empty rtt = no answer).
    pub fn export_csv(&self, dest: &Path) -> Result<u64, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT ts, target_id, rtt_ms FROM samples ORDER BY ts, target_id")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
        let mut out = std::io::BufWriter::new(file);
        writeln!(out, "ts_unix,target_id,rtt_ms").map_err(|e| e.to_string())?;
        let mut written = 0u64;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let ts: i64 = row.get(0).map_err(|e| e.to_string())?;
            let target: String = row.get(1).map_err(|e| e.to_string())?;
            let rtt: Option<f64> = row.get(2).map_err(|e| e.to_string())?;
            match rtt {
                Some(v) => writeln!(out, "{ts},{target},{v}"),
                None => writeln!(out, "{ts},{target},"),
            }
            .map_err(|e| e.to_string())?;
            written += 1;
        }
        out.flush().map_err(|e| e.to_string())?;
        Ok(written)
    }
}

/// Starts the 30 s background sampler. It runs for the whole life of the app, window open or not.
pub fn spawn_sampler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(SAMPLE_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut cycle: u64 = 0;

        loop {
            tick.tick().await;
            let history = app.state::<History>();
            // never record while our own bufferbloat test is saturating the line
            if !history.is_enabled() || crate::bufferbloat::is_active() {
                continue;
            }

            let probe = tauri::async_runtime::spawn_blocking(|| {
                let mut probe = network::probe_all_strategic(None);
                // Path segments (own router, first ISP hop) discovered by the last traceroute
                if let Some((gw, isp)) = route::path_probe_targets() {
                    probe.endpoints.extend(network::probe_path_points(&gw, isp.as_deref()));
                }
                probe
            })
            .await;
            if let Ok(probe) = probe {
                if let Err(e) = history.record_probe(now_secs(), &probe.endpoints) {
                    log::warn!("history: failed to record probe: {e}");
                }
            }

            if cycle % ROUTE_EVERY_CYCLES == 0 {
                let result = tauri::async_runtime::spawn_blocking(route::measure_route_cached).await;
                if let Ok(Ok(fresh)) = result {
                    if fresh.fresh {
                        if let Err(e) = history.record_route(now_secs(), &fresh.report) {
                            log::warn!("history: failed to record route: {e}");
                        }
                    }
                }
            }

            if cycle % MAINTENANCE_EVERY_CYCLES == 0 {
                if let Err(e) = history.maintenance(now_secs()) {
                    log::warn!("history: maintenance failed: {e}");
                }
            }
            cycle += 1;
        }
    });
}

pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("history.sqlite"))
        .map_err(|e| e.to_string())
}

/// Deterministic report over the local history. `tz_offset_minutes` = minutes to add to UTC for
/// the user's local time (JS: `-new Date().getTimezoneOffset()`).
#[tauri::command]
pub async fn history_analysis(
    app: AppHandle,
    tz_offset_minutes: i32,
    window_days: Option<u32>,
) -> Result<Report, String> {
    let days = window_days.unwrap_or(14).clamp(1, 90) as i64;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<History>().analyze(now_secs(), tz_offset_minutes, days)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Builds the evidence report (self-contained HTML) in the Downloads folder and returns its path.
#[tauri::command]
pub async fn history_export_report(
    app: AppHandle,
    tz_offset_minutes: i32,
    window_days: Option<u32>,
) -> Result<String, String> {
    let days = window_days.unwrap_or(14).clamp(1, 90) as i64;
    tauri::async_runtime::spawn_blocking(move || {
        let history = app.state::<History>();
        let now = now_secs();
        let analysis = history.analyze(now, tz_offset_minutes, days)?;
        let extras = history.evidence_extras(now - days * 24 * HOUR)?;
        let html = report::render(
            &analysis,
            &extras,
            &Meta { tz_offset_min: tz_offset_minutes, app_version: env!("CARGO_PKG_VERSION"), os: std::env::consts::OS },
        );
        let dir = dirs::download_dir()
            .or_else(dirs::home_dir)
            .ok_or_else(|| "Pasta de downloads não encontrada.".to_string())?;
        let dest = dir.join(format!("xcloud-monitor-relatorio-{now}.html"));
        std::fs::write(&dest, html).map_err(|e| e.to_string())?;
        Ok(dest.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Chart data for the last `window_hours` (clamped to 1 h .. 14 days, the raw retention).
#[tauri::command]
pub async fn history_series(app: AppHandle, window_hours: u32) -> Result<SeriesResponse, String> {
    let hours = window_hours.clamp(1, 14 * 24) as i64;
    tauri::async_runtime::spawn_blocking(move || app.state::<History>().series(now_secs(), hours * HOUR))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn history_stats(history: tauri::State<'_, History>) -> Result<HistoryStats, String> {
    history.stats()
}

#[tauri::command]
pub fn history_set_enabled(
    app: AppHandle,
    history: tauri::State<'_, History>,
    enabled: bool,
) -> Result<(), String> {
    history.set_enabled(enabled)?;
    crate::desktop::sync_collect_item(&app, enabled);
    Ok(())
}

#[tauri::command]
pub fn history_clear(history: tauri::State<'_, History>) -> Result<(), String> {
    history.clear()
}

/// Exports raw samples to the user's Downloads folder (a fixed location: the webview never
/// chooses a path to write). Returns the file path.
#[tauri::command]
pub fn history_export_csv(history: tauri::State<'_, History>) -> Result<String, String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Pasta de downloads não encontrada.".to_string())?;
    let dest = dir.join(format!("xcloud-monitor-historico-{}.csv", now_secs()));
    history.export_csv(&dest)?;
    Ok(dest.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(id: &str, rtt: Option<f64>) -> StrategicEndpoint {
        StrategicEndpoint {
            id: id.into(),
            label: id.into(),
            host: "h".into(),
            category: "azure_brazilsouth".into(),
            rtt_ms: rtt,
            online: rtt.is_some(),
            status: "BOA".into(),
        }
    }

    #[test]
    fn summarize_computes_loss_percentiles_and_jitter() {
        let s = summarize(&[Some(10.0), Some(20.0), None, Some(30.0), Some(40.0)]);
        assert_eq!((s.n, s.n_lost), (5, 1));
        assert_eq!(s.avg, Some(25.0));
        assert_eq!((s.min, s.max), (Some(10.0), Some(40.0)));
        assert_eq!(s.p50, Some(20.0));
        assert_eq!(s.p95, Some(40.0));
        // |20-10|, |30-20|, |40-30| over 3 gaps
        assert_eq!(s.jitter, Some(10.0));
    }

    #[test]
    fn summarize_all_lost_has_no_values() {
        let s = summarize(&[None, None]);
        assert_eq!((s.n, s.n_lost), (2, 2));
        assert!(s.avg.is_none() && s.p95.is_none() && s.jitter.is_none());
    }

    #[test]
    fn failed_probe_is_stored_as_null_not_a_value() {
        let h = History::open_in_memory().unwrap();
        h.record_probe(1_000, &[ep("a", Some(12.5)), ep("b", None)]).unwrap();
        let conn = h.lock();
        let a: Option<f64> = conn.query_row("SELECT rtt_ms FROM samples WHERE target_id='a'", [], |r| r.get(0)).unwrap();
        let b: Option<f64> = conn.query_row("SELECT rtt_ms FROM samples WHERE target_id='b'", [], |r| r.get(0)).unwrap();
        assert_eq!(a, Some(12.5));
        assert_eq!(b, None);
    }

    #[test]
    fn maintenance_rolls_up_complete_hours_only_and_prunes_after_rollup() {
        let h = History::open_in_memory().unwrap();
        let day = 24 * HOUR;
        let base = 100 * day; // hour-aligned
        h.record_probe(base + 10, &[ep("a", Some(10.0))]).unwrap();
        h.record_probe(base + 40, &[ep("a", None)]).unwrap();
        h.record_probe(base + HOUR + 5, &[ep("a", Some(50.0))]).unwrap(); // current hour: not rolled yet

        h.maintenance(base + HOUR + 60).unwrap();
        let conn = h.lock();
        let hours: i64 = conn.query_row("SELECT COUNT(*) FROM hourly", [], |r| r.get(0)).unwrap();
        assert_eq!(hours, 1);
        let (n, lost): (i64, i64) =
            conn.query_row("SELECT n, n_lost FROM hourly WHERE hour_ts = ?1", [base], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((n, lost), (2, 1));
        drop(conn);

        // 20 days later raw rows are pruned, aggregates stay.
        h.maintenance(base + 20 * day).unwrap();
        let st = h.stats().unwrap();
        assert_eq!(st.sample_count, 0);
        assert!(st.hourly_count >= 1);
    }

    #[test]
    fn raw_rows_are_not_pruned_before_being_rolled_up() {
        let h = History::open_in_memory().unwrap();
        let old = 50 * 24 * HOUR;
        h.record_probe(old + 5, &[ep("a", Some(9.0))]).unwrap();
        {
            // pretend an earlier rollup already passed this hour so it can never be aggregated
            let conn = h.lock();
            History::set_meta(&conn, "rollup_until", &(old - HOUR).to_string()).unwrap();
        }
        h.maintenance(old + 30 * 24 * HOUR).unwrap();
        // maintenance rolls it up first, then prunes
        assert_eq!(h.stats().unwrap().hourly_count, 1);
        assert_eq!(h.stats().unwrap().sample_count, 0);
    }

    #[test]
    fn collection_flag_defaults_on_and_clear_keeps_it() {
        let h = History::open_in_memory().unwrap();
        assert!(h.is_enabled());
        h.set_enabled(false).unwrap();
        h.record_probe(1, &[ep("a", Some(1.0))]).unwrap();
        h.clear().unwrap();
        assert!(!h.is_enabled());
        assert_eq!(h.stats().unwrap().sample_count, 0);
    }

    #[test]
    fn csv_export_leaves_lost_samples_empty() {
        let h = History::open_in_memory().unwrap();
        h.record_probe(7, &[ep("a", Some(1.5)), ep("b", None)]).unwrap();
        let path = std::env::temp_dir().join(format!("xcm-test-{}.csv", std::process::id()));
        assert_eq!(h.export_csv(&path).unwrap(), 2);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(text, "ts_unix,target_id,rtt_ms\n7,a,1.5\n7,b,\n");
    }

    /// Needs network: `cargo test live_record_cycle -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_record_cycle() {
        let path = std::env::temp_dir().join(format!("xcm-live-{}.sqlite", std::process::id()));
        let h = History::open(&path).unwrap();
        let probe = network::probe_all_strategic(None);
        h.record_probe(now_secs(), &probe.endpoints).unwrap();
        h.maintenance(now_secs()).unwrap();
        let st = h.stats().unwrap();
        println!("{st:#?}");
        for ep in &probe.endpoints {
            println!("{:<22} {:?}", ep.id, ep.rtt_ms);
        }
        assert_eq!(st.sample_count as usize, probe.endpoints.len());
        drop(h);
        for ext in ["", "-wal", "-shm"] {
            std::fs::remove_file(format!("{}{}", path.display(), ext)).ok();
        }
    }

    #[test]
    fn analyze_reads_pending_hours_and_runs_end_to_end() {
        let h = History::open_in_memory().unwrap();
        let now = 200 * 24 * HOUR + 1_800; // 30 min into an hour
        // two complete hours of data for the primary target, not rolled up yet
        for i in 0..240 {
            let ts = now - 2 * HOUR - 1_800 + i * 30;
            h.record_probe(ts, &[ep("xcloud_gssv_prod", Some(36.0)), ep("ix_rj", None)]).unwrap();
        }
        let report = h.analyze(now, -180, 7).unwrap();
        assert_eq!(report.primary_target.as_deref(), Some("xcloud_gssv_prod"));
        assert!(report.coverage_hours >= 2);
        assert_eq!(report.confidence, "insufficient");
        assert!(report.targets.iter().any(|t| t.id == "ix_rj" && t.status == "unreachable"));
    }

    #[test]
    fn opening_a_v1_database_adds_the_new_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE route_runs (ts INTEGER PRIMARY KEY, hairpin INTEGER NOT NULL, hop_count INTEGER NOT NULL,
               reached INTEGER NOT NULL, detected_pop TEXT, source TEXT, evidence TEXT);
             CREATE TABLE bufferbloat_runs (ts INTEGER PRIMARY KEY, idle_rtt REAL NOT NULL, loaded_rtt REAL NOT NULL,
               delta REAL NOT NULL, status TEXT NOT NULL);
             PRAGMA user_version = 1;",
        )
        .unwrap();
        let h = History::init(conn, PathBuf::new()).unwrap();
        let c = h.lock();
        c.execute("INSERT INTO route_runs(ts,hairpin,hop_count,reached,hops_json) VALUES(1,0,3,1,'[]')", []).unwrap();
        c.execute("INSERT INTO bufferbloat_runs(ts,idle_rtt,loaded_rtt,delta,status,down_mbps,grade) VALUES(1,10,20,10,'BOM',100.0,'A')", []).unwrap();
    }

    #[test]
    fn bucket_size_targets_about_240_points_in_whole_minutes() {
        assert_eq!(bucket_for_window(6 * HOUR), 120);
        assert_eq!(bucket_for_window(24 * HOUR), 360);
        assert_eq!(bucket_for_window(14 * 24 * HOUR), 5_040);
        assert_eq!(bucket_for_window(60), 60); // never below a minute
    }

    #[test]
    fn series_buckets_losses_picks_the_best_primary_and_skips_empty_targets() {
        let h = History::open_in_memory().unwrap();
        let now = 100 * 24 * HOUR;
        // 2 hours of 30 s samples: the gateway always answers, the xCloud entry loses 25%, a stray target is ignored
        for i in 0..240 {
            let ts = now - 2 * HOUR + i * 30;
            let lost = i % 4 == 0;
            h.record_probe(
                ts,
                &[
                    ep(analysis::GATEWAY_ID, Some(0.5)),
                    ep("xcloud_gssv_prod", if lost { None } else { Some(40.0) }),
                    ep("sp_google_dns", Some(39.0)),
                ],
            )
            .unwrap();
        }
        let r = h.series(now, 2 * HOUR).unwrap();
        assert_eq!(r.bucket_secs, bucket_for_window(2 * HOUR));
        let roles: Vec<&str> = r.series.iter().map(|s| s.role.as_str()).collect();
        assert_eq!(roles, vec!["local_gateway", "xcloud"]); // no ISP-hop data: no series, no fake line
        let x = r.series.iter().find(|s| s.role == "xcloud").unwrap();
        assert_eq!(x.id, "xcloud_gssv_prod");
        let total: i64 = x.points.iter().map(|p| p.n).sum();
        assert_eq!(total, 240);
        let avg_loss: f64 = x.points.iter().map(|p| p.loss_pct * p.n as f64).sum::<f64>() / total as f64;
        assert!((avg_loss - 25.0).abs() < 1.0, "{avg_loss}");
        assert!(x.points.iter().all(|p| p.p50 == Some(40.0)));
        let gw = r.series.iter().find(|s| s.role == "local_gateway").unwrap();
        assert!(gw.points.iter().all(|p| p.loss_pct == 0.0));
    }

    #[test]
    fn series_includes_route_and_bufferbloat_markers_and_respects_the_window() {
        let h = History::open_in_memory().unwrap();
        let now = 100 * 24 * HOUR;
        h.record_probe(now - 10 * HOUR, &[ep("xcloud_gssv_prod", Some(40.0))]).unwrap(); // outside a 2 h window
        h.record_probe(now - 60, &[ep("xcloud_gssv_prod", Some(41.0))]).unwrap();
        h.lock()
            .execute("INSERT INTO route_runs(ts,hairpin,hop_count,reached) VALUES(?1,1,5,0)", [now - 600])
            .unwrap();
        h.lock()
            .execute("INSERT INTO bufferbloat_runs(ts,idle_rtt,loaded_rtt,delta,status,grade) VALUES(?1,40,70,30,'BOM','B')", [now - 300])
            .unwrap();
        let r = h.series(now, 2 * HOUR).unwrap();
        assert_eq!(r.series.len(), 1);
        assert_eq!(r.series[0].points.iter().map(|p| p.n).sum::<i64>(), 1);
        assert_eq!(r.routes.len(), 1);
        assert!(r.routes[0].hairpin);
        assert_eq!(r.bloats[0].grade.as_deref(), Some("B"));
    }

    #[test]
    fn close_to_tray_defaults_on_persists_and_survives_clear() {
        let h = History::open_in_memory().unwrap();
        assert!(h.close_to_tray());
        h.set_meta_flag(crate::desktop::meta_close_to_tray_key(), false).unwrap();
        assert!(!h.close_to_tray());
        h.clear().unwrap();
        assert!(!h.close_to_tray(), "wiping measurements must not reset preferences");
    }

    #[test]
    fn rows_of_retired_targets_are_purged_when_the_database_opens() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute("INSERT INTO samples(ts,target_id,rtt_ms) VALUES(1,'ix_rj',NULL),(1,'xcloud_gssv_prod',40.0),(1,'us_equinix_miami',NULL)", []).unwrap();
        conn.execute("INSERT INTO hourly(hour_ts,target_id,n,n_lost) VALUES(0,'xcloud_brs_direct',120,0),(0,'xcloud_gssv_prod',120,0)", []).unwrap();
        let h = History::init(conn, PathBuf::new()).unwrap();
        let c = h.lock();
        let left: Vec<String> = c.prepare("SELECT target_id FROM samples").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(left, vec!["xcloud_gssv_prod"]);
        let hourly: i64 = c.query_row("SELECT COUNT(*) FROM hourly", [], |r| r.get(0)).unwrap();
        assert_eq!(hourly, 1);
    }
}
