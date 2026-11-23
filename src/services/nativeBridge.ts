import {
  StrategicEndpoint,
  TracerouteReport,
  XCloudServerStatus,
  LiveGameQueue,
  XCloudGameSearchResult,
} from '../types/telemetry';

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

/** Time-of-day congestion model for the xCloud Brazil South region. */
export async function fetchXCloudStatus(): Promise<XCloudServerStatus> {
  requireDesktop('O status do xCloud');
  return invokeTauri<XCloudServerStatus>('get_xcloud_status');
}

/** Real-time queue estimate for the active or queried game, from xCloud with the xStreaming session. */
export async function fetchActiveGameQueue(titleId?: string): Promise<LiveGameQueue | null> {
  requireDesktop('A fila do xCloud');
  const data: any = await invokeTauri('xcloud_active_game', { titleId: titleId ?? null });
  return data.ok ? data : null;
}

/** Recently played titles (xCloud MRU). */
export async function fetchRecentGames(): Promise<Array<{ titleId: string; productId: string; titleName: string; posterUrl?: string; lastTimePlayed?: string }>> {
  requireDesktop('Os jogos recentes');
  const data: any = await invokeTauri('xcloud_recent_games');
  return data.games || [];
}

/** Searches xCloud titles with name and box art. */
export async function searchXCloudGames(query: string): Promise<XCloudGameSearchResult[]> {
  if (!query || query.trim().length < 2) return [];
  requireDesktop('A busca de jogos');
  const data: any = await invokeTauri('xcloud_search_games', { query: query.trim() });
  return data.results || [];
}

/** Live wait time in seconds for a specific title. */
export async function fetchGameWaitTime(
  titleId: string
): Promise<{ estimatedWaitSeconds: number; estimatedWaitMinutes: number; provisioningSeconds: number; allocationSeconds: number }> {
  requireDesktop('A fila do xCloud');
  return invokeTauri('xcloud_waittime', { titleId });
}

/** Local xStreaming session status (gamertag, connected or not). */
export async function fetchUserSession(): Promise<{ connected: boolean; gamertag?: string; gamerpic?: string; region?: string; message?: string }> {
  requireDesktop('A sessão do xStreaming');
  return invokeTauri('xcloud_user_session');
}

// ---------------------------------------------------------------------------
// AI co-pilot (OpenAI). The key lives in the OS keychain, managed by the Rust backend.
// ---------------------------------------------------------------------------
const LEGACY_KEY_STORAGE = 'xcloud_openai_api_key';

export interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string;
  message: string;
}

export interface AiChatResponse {
  enabled: boolean;
  reply: string;
  error?: string;
  details?: string;
}

/** Moves a key saved by older builds from localStorage into the keychain. */
async function migrateLegacyKey(): Promise<void> {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
    if (!legacy) return;
    await invokeTauri('ai_save_key', { apiKey: legacy });
    localStorage.removeItem(LEGACY_KEY_STORAGE);
  } catch {
    // keep the legacy key if the keychain is unavailable
  }
}

export async function fetchAiStatus(): Promise<AiStatus> {
  requireDesktop('O copiloto de IA');
  await migrateLegacyKey();
  return invokeTauri<AiStatus>('ai_status');
}

export async function sendAiChat(payload: {
  message: string;
  context: unknown;
  history: unknown;
}): Promise<AiChatResponse> {
  requireDesktop('O copiloto de IA');
  return invokeTauri<AiChatResponse>('ai_chat', payload);
}

export async function verifyAiKey(apiKey: string): Promise<{ valid: boolean; message?: string }> {
  requireDesktop('A verificação da chave');
  return invokeTauri('ai_verify', { apiKey });
}

/** Saves (or, with an empty string, removes) the OpenAI key in the OS keychain. */
export async function saveAiKey(apiKey: string): Promise<void> {
  requireDesktop('O cofre de chaves');
  await invokeTauri('ai_save_key', { apiKey });
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
