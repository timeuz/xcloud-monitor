/**
 * Telemetry and Network Diagnostic types for Xbox Cloud Gaming (xCloud)
 * Based on XCLOUD.md technical specification and r/xcloud telemetry inputs.
 */

export type ConnectionQuality = 'BOA' | 'ATENÇÃO' | 'RUIM';

export type GamingRank = 'S' | 'A' | 'B' | 'F';

export type RootCauseCategory = 'LOCAL_CONNECTION' | 'ISP_ROUTE' | 'NOMINAL';

export type NetworkTrendStatus = 'ESTÁVEL' | 'MELHORANDO' | 'OSCILANDO' | 'DEGRADANDO';

export interface TelemetryResilience {
  trend: NetworkTrendStatus;
  stabilityScore: number; // 0 - 100%
  windowSampleCount: number;
  confirmedCycles: number;
}

export interface NetworkMetrics {
  rttMs: number;
  rttAvgMs: number;
  smoothedRttMs?: number;
  jitterMs: number;
  smoothedJitterMs?: number;
  packetLossPct: number;
  /** null until a bufferbloat test has been run: there is no default value */
  bufferbloatDeltaMs: number | null;
  samplesSent: number;
  samplesLost: number;
  resilience?: TelemetryResilience;
}

export interface StrategicEndpoint {
  id: string;
  label: string;
  host: string;
  category: 'borda_brasil' | 'azure_brazilsouth' | 'ix_nacional' | 'referencia_internacional' | 'ipv6';
  rttMs: number | null;
  online: boolean;
  status: ConnectionQuality | 'TIMEOUT' | 'REF-EUA';
}

export interface AnomalyDiagnostic {
  severity: 1 | 2 | 3 | 4;
  code: 'BGP_HAIRPINNING' | 'HIGH_PACKET_LOSS' | 'BUFFERBLOAT_SATURATION' | 'WIFI_24GHZ_INSTABILITY';
  alert: string;
  cause: string;
  recommendation: string;
}

export interface RouteHop {
  ttl: number;
  ip: string;
  host: string;
  rttMs: number;
  location: string;
  isAnomaly?: boolean;
}

export interface TracerouteReport {
  target: string;
  isHairpinning: boolean;
  hopCount: number;
  hops: RouteHop[];
  detectedPop?: string | null;
  summary: string;
  /** Human-readable measurements backing the verdict (real traceroute only). */
  evidence?: string[];
  /** Whether the destination itself answered the trace. */
  reached?: boolean;
  /** Tool that produced the data: traceroute | tracepath | tracert. */
  source?: string;
  measuredAt?: number;
}

export interface GamingVerdict {
  rank: GamingRank;
  headline: string;
  isGoodTimeToPlay: boolean;
  statusText: string;
  rootCauseCategory: RootCauseCategory;
  rootCauseTitle: string;
  rootCauseDescription: string;
  actionableTip: string;
}

export interface CoPilotMessage {
  id: string;
  text: string;
  type: 'info' | 'warning' | 'alert' | 'success';
  timestamp: number;
}

