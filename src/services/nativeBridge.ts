import { RouteHop, StrategicEndpoint, TracerouteReport } from '../types/telemetry';

export interface TelemetryProbeResponse {
  timestamp: number;
  endpoints: StrategicEndpoint[];
  /** null = target did not answer; never a made-up default. */
  spEdgeRtt: number | null;
  azureRtt: number | null;
  usMiamiRtt: number | null;
  customHost?: {
    host: string;
    rttMs: number | null;
    online: boolean;
  } | null;
}

export interface BufferbloatResponse {
  idleRtt: number;
  loadedRtt: number;
  deltaBufferbloat: number;
  status: 'EXCELENTE' | 'BOM' | 'ATENÇÃO' | 'CRÍTICO_BUFFERBLOAT';
  idleP95?: number | null;
  downMbps?: number;
  upMbps?: number;
  /** Median latency increase while downloading / uploading; null = that direction produced no load. */
  deltaDown?: number | null;
  deltaUp?: number | null;
  /** Router latency increase under load: high means the LAN/Wi-Fi itself saturates. */
  gatewayDeltaDown?: number | null;
  gatewayDeltaUp?: number | null;
  grade?: string;
  dataUsedMb?: number;
}

/**
 * Checks if the application is running inside a Tauri native desktop window.
 */
export function isTauriApp(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI__ ||
    (window as any).__TAURI_METADATA__
  );
}

/** Lazy IPC call into the Rust backend (the module also loads, and its pure helpers work, outside Tauri). */
async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** Network probe of every strategic target (native ICMP ping with TCP fallback, in the Rust backend). */
export async function fetchTelemetryProbe(customHost?: string): Promise<TelemetryProbeResponse> {
  requireDesktop('A sondagem de rede');
  return invokeTauri<TelemetryProbeResponse>('probe_telemetry', { customHost: customHost || null });
}

/**
 * Bufferbloat test: latency while the line is saturated in download and upload. Desktop only.
 */
export async function executeBufferbloatTest(): Promise<BufferbloatResponse> {
  requireDesktop('O teste de bufferbloat');
  return invokeTauri<BufferbloatResponse>('run_bufferbloat');
}

/**
 * Measured hop-by-hop route (system traceroute) with hairpinning evidence. Desktop only.
 */
export async function fetchTracerouteReport(): Promise<TracerouteReport> {
  requireDesktop('A medição real de rota');
  return invokeTauri<TracerouteReport>('run_traceroute');
}

// ---------------------------------------------------------------------------
// Local measurement history (SQLite in the app data dir). Desktop only.
// ---------------------------------------------------------------------------
export interface HistoryStats {
  enabled: boolean;
  sampleCount: number;
  hourlyCount: number;
  routeRuns: number;
  bufferbloatRuns: number;
  oldestTs: number | null;
  newestTs: number | null;
  dbBytes: number;
  intervalSecs: number;
  rawRetentionDays: number;
}

function requireDesktop(feature: string): void {
  if (!isTauriApp()) throw new Error(`${feature} exige o aplicativo desktop`);
}

export async function fetchHistoryStats(): Promise<HistoryStats> {
  requireDesktop('O histórico local');
  return invokeTauri<HistoryStats>('history_stats');
}

export async function setHistoryEnabled(enabled: boolean): Promise<void> {
  requireDesktop('O histórico local');
  await invokeTauri('history_set_enabled', { enabled });
}

export async function clearHistory(): Promise<void> {
  requireDesktop('O histórico local');
  await invokeTauri('history_clear');
}

/** Writes the raw samples CSV to the Downloads folder and returns its path. */
export async function exportHistoryCsv(): Promise<string> {
  requireDesktop('A exportação do histórico');
  return invokeTauri<string>('history_export_csv');
}

// ---------------------------------------------------------------------------
// Deterministic analysis of the local history (no AI involved).
// ---------------------------------------------------------------------------
export interface TargetQuality {
  id: string;
  samples: number;
  answerRate: number;
  p50: number | null;
  p95: number | null;
  jitter: number | null;
  status: 'ok' | 'flaky' | 'unreachable' | 'insufficient';
}

export interface HourProfile {
  hour: number;
  days: number;
  p50: number;
  p95: number | null;
  lossPct: number;
  jitter: number | null;
}

export interface PeakHour {
  group: 'weekday' | 'weekend';
  hour: number;
  p50: number;
  baseline: number;
  deltaMs: number;
}

export interface DegradationEpisode {
  start: number;
  end: number;
  durationMin: number;
  kind: 'latencia' | 'perda' | 'mista';
  peakRtt: number | null;
  lossPct: number;
  scope: 'all-targets' | 'primary-only' | 'unknown';
  routeHairpin: boolean;
  /** Where the episode started, from the router and first-ISP-hop probes. */
  cause: 'local' | 'isp-access' | 'isp-core' | 'beyond-local' | 'microsoft-path' | 'unknown';
}

export interface WindowStats {
  samples: number;
  p50: number | null;
  p95: number | null;
  lossPct: number;
}

export interface SegmentStats {
  role: 'local_gateway' | 'isp_hop1' | 'xcloud';
  label: string;
  id: string;
  samples: number;
  answerRate: number;
  p50: number | null;
  p95: number | null;
  jitter: number | null;
  lossPct: number;
  duringEpisodes: WindowStats | null;
}

export interface AnalysisInsight {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  suggestion: string | null;
}

export interface AnalysisReport {
  generatedAt: number;
  windowDays: number;
  coverageHours: number;
  confidence: 'insufficient' | 'low' | 'medium' | 'high';
  primaryTarget: string | null;
  baselineP50: number | null;
  targets: TargetQuality[];
  profileWeekday: HourProfile[];
  profileWeekend: HourProfile[];
  peakHours: PeakHour[];
  episodes: DegradationEpisode[];
  pathComparison: SegmentStats[];
  insights: AnalysisInsight[];
}

export async function fetchHistoryAnalysis(windowDays = 14): Promise<AnalysisReport> {
  requireDesktop('A análise do histórico');
  return invokeTauri<AnalysisReport>('history_analysis', {
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
    windowDays,
  });
}

/** Writes the evidence report (self-contained HTML, prints to PDF) to Downloads and returns its path. */
export async function exportEvidenceReport(windowDays = 14): Promise<string> {
  requireDesktop('O relatório de evidência');
  return invokeTauri<string>('history_export_report', {
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
    windowDays,
  });
}

// ---------------------------------------------------------------------------
// Chart data (bucketed time series) from the local history.
// ---------------------------------------------------------------------------
export interface SeriesPoint {
  ts: number;
  p50: number | null;
  p95: number | null;
  lossPct: number;
  n: number;
}

export interface HistorySeries {
  id: string;
  role: 'local_gateway' | 'isp_hop1' | 'xcloud';
  label: string;
  points: SeriesPoint[];
}

export interface HistorySeriesResponse {
  from: number;
  to: number;
  bucketSecs: number;
  series: HistorySeries[];
  routes: { ts: number; hairpin: boolean }[];
  bloats: { ts: number; delta: number; grade: string | null }[];
}

export async function fetchHistorySeries(windowHours: number): Promise<HistorySeriesResponse> {
  requireDesktop('Os gráficos do histórico');
  return invokeTauri<HistorySeriesResponse>('history_series', { windowHours });
}

// ---------------------------------------------------------------------------
// Desktop shell: tray / close-to-tray / autostart.
// ---------------------------------------------------------------------------
export interface DesktopSettings {
  closeToTray: boolean;
  /** false when the OS could not provide a tray icon: closing the window then quits the app. */
  trayAvailable: boolean;
  autostart: boolean;
}

export async function fetchDesktopSettings(): Promise<DesktopSettings> {
  requireDesktop('As opções de segundo plano');
  return invokeTauri<DesktopSettings>('desktop_settings');
}

export async function setCloseToTray(enabled: boolean): Promise<void> {
  requireDesktop('As opções de segundo plano');
  await invokeTauri('set_close_to_tray', { enabled });
}

export async function setAutostart(enabled: boolean): Promise<void> {
  requireDesktop('A inicialização com o sistema');
  await invokeTauri('set_autostart', { enabled });
}

// ---------------------------------------------------------------------------
// Signed auto-update (desktop). Verification of the package signature happens in the Rust plugin.
// ---------------------------------------------------------------------------
export interface UpdateInfo {
  currentVersion: string;
  version: string;
  notes: string | null;
  /** false = this install cannot replace itself (Linux outside an AppImage); point the user to the release page. */
  installable: boolean;
}

export async function fetchAppVersion(): Promise<string> {
  requireDesktop('A versão do aplicativo');
  return invokeTauri<string>('app_version');
}

/** Resolves to the available update, or null when already up to date. Rejects when it could not check. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  requireDesktop('A atualização automática');
  return invokeTauri<UpdateInfo | null>('update_check');
}

/** Downloads, verifies, installs and restarts the app. Only acts on the update found by the last check. */
export async function installUpdate(): Promise<void> {
  requireDesktop('A atualização automática');
  await invokeTauri('update_install');
}

export async function openReleasesPage(): Promise<void> {
  requireDesktop('A página de releases');
  await invokeTauri('open_releases_page');
}

// ---------------------------------------------------------------------------
// UDP path test (STUN Binding Requests at 50 packets/s). Desktop only.
// ---------------------------------------------------------------------------
export interface UdpStats {
  sent: number;
  received: number;
  lossPct: number;
  rttP50: number | null;
  rttP95: number | null;
  rttMax: number | null;
  jitter: number | null;
  /** longest run of consecutive unanswered packets */
  maxBurstLoss: number;
}

export interface UdpTargetResult extends UdpStats {
  id: string;
  label: string;
  addr: string;
  error: string | null;
}

export interface UdpTestResponse {
  measuredAt: number;
  packetsPerSecond: number;
  durationSecs: number;
  results: UdpTargetResult[];
}

export interface UdpRunRow {
  ts: number;
  targetId: string;
  label: string;
  sent: number;
  received: number;
  lossPct: number;
  rttP50: number | null;
  rttP95: number | null;
  rttMax: number | null;
  jitter: number | null;
  maxBurst: number;
}

/** About 35 s: 10 s of 50 packets/s to each of three public STUN servers. */
export async function runUdpTest(): Promise<UdpTestResponse> {
  requireDesktop('O teste UDP');
  return invokeTauri<UdpTestResponse>('run_udp_test');
}

export async function fetchUdpRuns(limit = 30): Promise<UdpRunRow[]> {
  requireDesktop('O histórico de testes UDP');
  return invokeTauri<UdpRunRow[]>('history_udp_runs', { limit });
}

// ---------------------------------------------------------------------------
// Game session server (its address changes every match and is supplied by the user).
// ---------------------------------------------------------------------------
export interface SessionRun {
  ts: number;
  peerIp: string;
  note: string | null;
  sent: number;
  received: number;
  lossPct: number;
  rttP50: number | null;
  rttP95: number | null;
  jitter: number | null;
  /** xCloud entry point RTT measured by the sampler just before; null when there was none */
  entryRtt: number | null;
  /** the server never answered ICMP (the route may still be shown) */
  icmpBlocked: boolean;
  hairpin: boolean;
  hopCount: number;
  hops: RouteHop[];
  largestJump: { fromTtl: number; fromIp: string; toTtl: number; toIp: string; deltaMs: number; toRtt: number } | null;
}

/** Pings and traces a public IPv4 (accepts "ip", "ip:port" or tcpdump's "ip.port"). Takes up to ~1 minute. */
export async function measureSessionPeer(peer: string, note?: string): Promise<SessionRun> {
  requireDesktop('A medição do servidor da sessão');
  return invokeTauri<SessionRun>('measure_session_peer', { peer, note: note ?? null });
}

export interface PeerCandidate {
  ip: string;
  port: number | null;
  bytes: number;
  packets: number;
}

/** Linux: captures UDP for a few seconds (graphical admin prompt) and returns the busiest public peers. */
export async function detectSessionPeers(): Promise<PeerCandidate[]> {
  requireDesktop('A detecção do servidor da sessão');
  return invokeTauri<PeerCandidate[]>('detect_session_peers');
}

export async function fetchSessionRuns(limit = 20): Promise<SessionRun[]> {
  requireDesktop('O histórico do servidor da sessão');
  return invokeTauri<SessionRun[]>('history_session_runs', { limit });
}
