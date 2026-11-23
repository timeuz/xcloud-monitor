import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  NetworkMetrics,
  StrategicEndpoint,
  TracerouteReport,
  GamingVerdict,
  GamingRank,
} from './types/telemetry';
import { NetworkMap2D } from './components/NetworkMap2D';
import { VerdictBanner } from './components/VerdictBanner';
import { TelemetryGauges } from './components/TelemetryGauges';
import { StrategicMatrix } from './components/StrategicMatrix';
import { RouteDiagnostics } from './components/RouteDiagnostics';
import { SimulationControls } from './components/SimulationControls';
import { ReportModal } from './components/ReportModal';
import { HistoryView } from './components/HistoryView';
import { UpdateBanner } from './components/UpdateBanner';
import { DesktopOnlyNotice } from './components/DesktopOnlyNotice';
import { computeVerdict, rawRankWithHysteresis } from './domain/verdict';
import { FORCED_HAIRPIN, nextHairpinState, smoothRtt } from './domain/telemetry';
import { SettingsModal } from './components/SettingsModal';
import {
  fetchTelemetryProbe,
  executeBufferbloatTest,
  fetchTracerouteReport,
  fetchAppVersion,
  isTauriApp,
} from './services/nativeBridge';
import {
  Activity,
  Server,
  Network,
  Cpu,
  FileText,
  RefreshCw,
  Compass,
  Sliders,
  Radio,
  Settings,
} from 'lucide-react';

function Dashboard() {
  // Navigation & View Tab State
  const [activeTab, setActiveTab] = useState<'dashboard' | 'route' | 'servers' | 'history'>('dashboard');
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTestingBufferbloat, setIsTestingBufferbloat] = useState(false);
  const [activeSimulation, setActiveSimulation] = useState<string | null>(null);

  // Core Metrics State
  const [metrics, setMetrics] = useState<NetworkMetrics>({
    // Placeholders only: nothing is shown until the first real probe answers (see hasMeasurement)
    rttMs: 0,
    rttAvgMs: 0,
    jitterMs: 0,
    packetLossPct: 0,
    bufferbloatDeltaMs: null,
    samplesSent: 0,
    samplesLost: 0,
  });
  const [hasMeasurement, setHasMeasurement] = useState(false);
  const hasSampleRef = useRef(false);

  const [rttHistory, setRttHistory] = useState<number[]>([]);
  const [jitterHistory, setJitterHistory] = useState<number[]>([]);
  const [lossHistory, setLossHistory] = useState<number[]>([]);

  // Resilient Statistical Filtering, Sliding Window & Confirmation Refs
  // Rolling window of probe outcomes (1 = no answer) used to compute real packet loss
  const lossWindowRef = useRef<number[]>([]);
  const rttWindowRef = useRef<number[]>([]);
  const jitterWindowRef = useRef<number[]>([]);
  const confirmedHairpinningRef = useRef(false);
  const consecutiveHairpinningCountRef = useRef(0);
  const consecutiveNormalCountRef = useRef(0);
  const isProbingRef = useRef(false);
  const candidateRankRef = useRef<{ rank: GamingRank; count: number }>({ rank: 'S', count: 0 });
  const [stableRank, setStableRank] = useState<GamingRank>('S');

  // Measured endpoints; empty until the first probe answers (no placeholder values)
  const [endpoints, setEndpoints] = useState<StrategicEndpoint[]>([]);

  const [customHostResult, setCustomHostResult] = useState<{ host: string; rttMs: number | null; online: boolean } | null>(null);

  // Traceroute State
  const [traceroute, setTraceroute] = useState<TracerouteReport>({
    target: 'xCloud (entrada)',
    isHairpinning: false,
    hopCount: 0,
    hops: [],
    summary: 'Medindo a rota até o cluster xCloud...',
  });

  // Real route measurement (system traceroute). Slow and noisy on the network, so every 5 minutes.
  const refreshTraceroute = useCallback(async () => {
    try {
      setTraceroute(await fetchTracerouteReport());
    } catch (err: any) {
      setTraceroute((prev) => ({
        ...prev,
        isHairpinning: false,
        hopCount: 0,
        hops: [],
        evidence: [],
        summary: `Rota indisponível: ${err?.message || err}`,
      }));
    }
  }, []);

  useEffect(() => {
    refreshTraceroute();
    const id = setInterval(refreshTraceroute, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshTraceroute]);

  // Hairpinning state: resilient confirmation with hysteresis (prevents rapid flapping on threshold borders)
  const isHairpinning =
    activeSimulation === 'hairpinning' ||
    traceroute.isHairpinning ||
    confirmedHairpinningRef.current;


  const rawVerdict = computeVerdict({ metrics, isHairpinning });
  // The effective verdict uses the confirmed stable rank to prevent micro-fluctuations
  const verdict: GamingVerdict = {
    ...rawVerdict,
    rank: activeSimulation ? rawVerdict.rank : stableRank,
  };

  // Periodic Telemetry Fetch from Backend API or Tauri Native Bridge
  const fetchTelemetry = useCallback(async () => {
    if (isProbingRef.current) return;
    isProbingRef.current = true;

    try {
      const data = await fetchTelemetryProbe();
      if (data?.endpoints) {
        setEndpoints(data.endpoints);
      }

        // If not in a synthetic simulation, update live metrics smoothly
        if (!activeSimulation) {
          const measuredRtt = data.azureRtt ?? data.spEdgeRtt ?? null;
          lossWindowRef.current = [...lossWindowRef.current.slice(-49), measuredRtt === null ? 1 : 0];
          const lossPct =
            Math.round((lossWindowRef.current.reduce((a, b) => a + b, 0) / lossWindowRef.current.length) * 10000) / 100;

          if (measuredRtt === null) {
            // No answer from the xCloud/edge targets: that is a lost sample, not a "nominal" reading.
            setMetrics((prev) => ({
              ...prev,
              samplesSent: prev.samplesSent + 1,
              samplesLost: prev.samplesLost + 1,
              packetLossPct: lossPct,
            }));
            setLossHistory((prev) => [...prev.slice(-20), lossPct]);
            return;
          }
          const liveRtt = measuredRtt;
          // The first answer seeds the filters: nothing invented is blended into real measurements.
          const first = !hasSampleRef.current;
          hasSampleRef.current = true;
          setHasMeasurement(true);
          setMetrics((current) => {
            const prev: NetworkMetrics = first
              ? { ...current, rttMs: liveRtt, rttAvgMs: liveRtt, smoothedRttMs: liveRtt, jitterMs: 0, smoothedJitterMs: 0 }
              : current;
            const nextSent = prev.samplesSent + 1;
            const nextAvg = (prev.rttAvgMs * prev.samplesSent + liveRtt) / nextSent;
            // RFC 3550 EWMA Jitter
            const dK = Math.abs(liveRtt - prev.rttMs);
            const nextJitter = prev.jitterMs + (dK - prev.jitterMs) / 16.0;

            // Exponential Moving Average (EMA) smoothing for resilience against single-sample noise
            const prevSmoothedRtt = prev.smoothedRttMs ?? prev.rttMs ?? liveRtt;
            const nextSmoothedRtt = smoothRtt(prevSmoothedRtt, liveRtt);

            const prevSmoothedJitter = prev.smoothedJitterMs ?? prev.jitterMs ?? nextJitter;
            const nextSmoothedJitter = Math.round((prevSmoothedJitter * 0.75 + nextJitter * 0.25) * 100) / 100;

            // Resilient Sliding Window Calculations
            rttWindowRef.current = [...rttWindowRef.current.slice(-9), liveRtt];
            jitterWindowRef.current = [...jitterWindowRef.current.slice(-9), nextJitter];

            const n = rttWindowRef.current.length;
            const windowMean = rttWindowRef.current.reduce((a, b) => a + b, 0) / n;
            const variance = rttWindowRef.current.reduce((acc, val) => acc + Math.pow(val - windowMean, 2), 0) / n;
            const stdDev = Math.sqrt(variance);

            // Stability score from 10 to 100%
            const stabilityScore = Math.max(10, Math.min(100, Math.round(100 - (nextSmoothedJitter * 3.5 + stdDev * 3.0))));

            // Trend analysis over sliding window
            let trend: 'ESTÁVEL' | 'MELHORANDO' | 'OSCILANDO' | 'DEGRADANDO' = 'ESTÁVEL';
            if (stdDev > 5.0 || nextSmoothedJitter > 6.0) {
              trend = 'OSCILANDO';
            } else if (rttWindowRef.current.length >= 6) {
              const early = rttWindowRef.current.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
              const late = rttWindowRef.current.slice(-3).reduce((a, b) => a + b, 0) / 3;
              if (late - early < -4.0) {
                trend = 'MELHORANDO';
              } else if (late - early > 4.0) {
                trend = 'DEGRADANDO';
              } else {
                trend = 'ESTÁVEL';
              }
            }

            // Resilient BGP Hairpinning Detection:
            // Hairpinning specifically occurs when traffic to SP (AS8075) leaks to US PoPs (Miami/Atlanta).
            // If spEdgeRtt is low (<= 45ms), packets to IX.br SP are strictly domestic!
            {
              const forced = activeSimulation === 'hairpinning' || traceroute.isHairpinning;
              const next = forced
                ? FORCED_HAIRPIN
                : nextHairpinState(
                    {
                      confirmed: confirmedHairpinningRef.current,
                      hairpinCount: consecutiveHairpinningCountRef.current,
                      normalCount: consecutiveNormalCountRef.current,
                    },
                    { liveRtt, smoothedRtt: nextSmoothedRtt, spEdgeRtt: data.spEdgeRtt, usMiamiRtt: data.usMiamiRtt }
                  );
              confirmedHairpinningRef.current = next.confirmed;
              consecutiveHairpinningCountRef.current = next.hairpinCount;
              consecutiveNormalCountRef.current = next.normalCount;
            }

            // Target rank evaluation using stateful hysteresis
            const rawTargetRank = rawRankWithHysteresis(
              first ? 'A' : stableRank,
              nextSmoothedRtt,
              nextSmoothedJitter,
              prev.packetLossPct,
              prev.bufferbloatDeltaMs,
              confirmedHairpinningRef.current
            );

            if (candidateRankRef.current.rank === rawTargetRank) {
              candidateRankRef.current.count += 1;
            } else {
              candidateRankRef.current = { rank: rawTargetRank, count: 1 };
            }

            // Multi-cycle confirmation: 4 cycles for upgrades, 3 cycles for downgrades
            const RANK_VALS: Record<GamingRank, number> = { S: 4, A: 3, B: 2, F: 1 };
            const isUpgrade = RANK_VALS[rawTargetRank] > RANK_VALS[stableRank];
            const requiredConfirmations = isUpgrade ? 4 : 3;

            if (first) {
              candidateRankRef.current = { rank: rawTargetRank, count: requiredConfirmations };
              setStableRank(rawTargetRank);
            } else if (candidateRankRef.current.count >= requiredConfirmations) {
              setStableRank(candidateRankRef.current.rank);
            }

            return {
              ...prev,
              rttMs: liveRtt,
              rttAvgMs: Math.round(nextAvg * 10) / 10,
              smoothedRttMs: nextSmoothedRtt,
              jitterMs: Math.round(nextJitter * 100) / 100,
              smoothedJitterMs: nextSmoothedJitter,
              samplesSent: nextSent,
              packetLossPct: lossPct,
              resilience: {
                trend,
                stabilityScore,
                windowSampleCount: rttWindowRef.current.length,
                confirmedCycles: candidateRankRef.current.count,
              },
            };
          });

          setRttHistory((prev) => [...prev.slice(-20), liveRtt]);
          setJitterHistory((prev) => [...prev.slice(-20), metrics.jitterMs]);
          setLossHistory((prev) => [...prev.slice(-20), lossPct]);
        }
    } catch (e) {
      // Backend probe fallback
    } finally {
      isProbingRef.current = false;
    }
  }, [activeSimulation, metrics.jitterMs, metrics.packetLossPct, stableRank, traceroute.isHairpinning]);

  useEffect(() => {
    fetchAppVersion().then(setAppVersion).catch(() => {});
    try {
      localStorage.removeItem('xcloud_openai_api_key'); // key stored by older builds
    } catch {
      // storage unavailable
    }
  }, []);

  // Ensure the page stays at the very top on load and on tab switch
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
  }, [activeTab]);

  // Periodic polling interval
  useEffect(() => {
    fetchTelemetry();

    const interval = setInterval(() => {
      fetchTelemetry();
    }, 4000);

    return () => {
      clearInterval(interval);
    };
  }, [fetchTelemetry]);

  // Active Bufferbloat Burst Runner
  const [bufferbloatNote, setBufferbloatNote] = useState('');

  const handleTriggerBufferbloat = async () => {
    setIsTestingBufferbloat(true);

    try {
      setBufferbloatNote('');
      const data = await executeBufferbloatTest();
      if (data) {
        setMetrics((prev) => ({
          ...prev,
          bufferbloatDeltaMs: data.deltaBufferbloat,
        }));
        const part = (label: string, mbps?: number, delta?: number | null) =>
          delta == null ? `${label} sem carga` : `${label} ${mbps?.toFixed(0)} Mbps (+${delta.toFixed(0)} ms)`;
        setBufferbloatNote(
          `Nota ${data.grade ?? '—'} · ${part('↓', data.downMbps, data.deltaDown)} · ${part('↑', data.upMbps, data.deltaUp)} · ${data.dataUsedMb?.toFixed(0)} MB usados`
        );
      }
    } catch (e) {
      // Test failed (target unreachable): keep the previous value instead of inventing one
      console.warn('Teste de bufferbloat falhou:', e);
      setBufferbloatNote(`Teste cancelado: ${(e as any)?.message ?? e}`);
    } finally {
      setIsTestingBufferbloat(false);
    }
  };

  // User Custom Host Probe
  const handleProbeCustomHost = async (host: string) => {
    try {
      const data = await fetchTelemetryProbe(host);
      if (data?.customHost) {
        setCustomHostResult(data.customHost);
      }
    } catch (e) {
      setCustomHostResult({ host, rttMs: null, online: false });
    }
  };

  const handleClearCustomHost = () => {
    setCustomHostResult(null);
  };

  // Simulation Levers - Sound triggers exclusively via verdict.rank transition effect
  const handleSimulateHairpinning = () => {
    hasSampleRef.current = true;
    setHasMeasurement(true);
    confirmedHairpinningRef.current = true;
    consecutiveHairpinningCountRef.current = 5;
    consecutiveNormalCountRef.current = 0;
    setActiveSimulation('hairpinning');
    setStableRank('F');
    setMetrics((prev) => ({
      ...prev,
      rttMs: 138.4,
      rttAvgMs: 135.2,
      smoothedRttMs: 138.4,
      jitterMs: 4.8,
      smoothedJitterMs: 4.8,
    }));
    setTraceroute((prev) => ({
      ...prev,
      isHairpinning: true,
      summary: 'ALERTA BGP: Tráfego redirecionado aos Estados Unidos (Atlanta CIX-ATL / Miami) antes de chegar a São Paulo!',
      hops: [
        { ttl: 1, ip: '192.168.1.1', host: 'gateway.lan', rttMs: 1.2, location: 'Rede Local' },
        { ttl: 2, ip: '100.64.0.1', host: 'cgnat.isp.net.br', rttMs: 4.8, location: 'CGNAT Operadora' },
        { ttl: 3, ip: '187.16.216.1', host: 'ix-sp.br', rttMs: 12.4, location: 'IX.br SP' },
        { ttl: 4, ip: '198.32.242.188', host: 'equinix-miami.as8075.net', rttMs: 118.5, location: 'Equinix Miami (EUA) - DESVIO CABO SUBMARINO' },
        { ttl: 5, ip: '198.32.182.105', host: 'cix-atl.ix-1668.as8075.net', rttMs: 134.2, location: 'Atlanta CIX-ATL (EUA)' },
        { ttl: 6, ip: '20.209.1.1', host: 'us-east.azure.microsoft.com', rttMs: 139.1, location: 'Nó BGP Internacional' },
        { ttl: 7, ip: '104.44.239.10', host: 'brazilsouth.azure.microsoft.com', rttMs: 142.8, location: 'Azure brazilsouth (Retorno via Trânsito)' },
      ],
    }));
  };

  const handleSimulateBufferbloat = () => {
    hasSampleRef.current = true;
    setHasMeasurement(true);
    setActiveSimulation('bufferbloat');
    setStableRank('B');
    setMetrics((prev) => ({
      ...prev,
      bufferbloatDeltaMs: 68.4,
    }));
  };


  const handleResetNominal = () => {
    rttWindowRef.current = [];
    jitterWindowRef.current = [];
    lossWindowRef.current = [];
    confirmedHairpinningRef.current = false;
    consecutiveHairpinningCountRef.current = 0;
    consecutiveNormalCountRef.current = 0;
    candidateRankRef.current = { rank: 'S', count: 0 };
    hasSampleRef.current = false;
    setHasMeasurement(false);
    setActiveSimulation(null);
    setRttHistory([]);
    setJitterHistory([]);
    setLossHistory([]);
    setMetrics({ rttMs: 0, rttAvgMs: 0, jitterMs: 0, packetLossPct: 0, bufferbloatDeltaMs: null, samplesSent: 0, samplesLost: 0 });
    refreshTraceroute();
  };

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await fetchTelemetry();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  return (
    <div className="min-h-screen bg-[#03080d] text-slate-100 flex flex-col selection:bg-cyan-500 selection:text-black">
      {/* Top Bar Header Contract (Clean 3 zones) */}
      <header className="sticky top-0 z-40 bg-[#040b12]/95 backdrop-blur-md border-b border-cyan-900/40 px-4 lg:px-8 py-3 flex items-center justify-between gap-8">
        {/* Zone 1: Single text element wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center">
            <Radio className="w-4 h-4 text-emerald-400 animate-pulse" />
          </div>
          <div>
            <div className="text-base font-bold font-mono tracking-tight text-slate-100 uppercase whitespace-nowrap">
              XCLOUD // CYBER-MONITOR
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-cyan-400">
              <span>AS8075 · brazilsouth · IX.br SP</span>
            </div>
          </div>
        </div>

        {/* Zone 2: Navigation Links / View Switcher */}
        <nav className="hidden md:flex items-center gap-2 text-xs font-mono font-medium text-slate-400">
          <button
            onClick={() => {
              setActiveTab('dashboard');
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'dashboard'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'hover:text-slate-200'
            }`}
          >
            Painel Geral
          </button>
          <button
            onClick={() => {
              setActiveTab('route');
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'route'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'hover:text-slate-200'
            }`}
          >
            Rota & BGP
          </button>
          <button
            onClick={() => {
              setActiveTab('servers');
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'servers'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'hover:text-slate-200'
            }`}
          >
            Alvos de Medição
          </button>
          <button
            onClick={() => {
              setActiveTab('history');
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'history'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'hover:text-slate-200'
            }`}
          >
            Histórico
          </button>
        </nav>

        {/* Zone 3: Primary Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => {
              setIsSettingsOpen(true);
            }}
            className="p-2 rounded-lg bg-cyan-950/40 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-800/40 transition-colors"
            title="Configurações"
          >
            <Settings className="w-4 h-4 text-cyan-400" />
          </button>
          <button
            onClick={handleManualRefresh}
            className="p-2 rounded-lg bg-cyan-950/40 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-800/40 transition-colors"
            title="Sondar agora"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => {
              setIsReportOpen(true);
            }}
            className="p-2 xl:px-3.5 xl:py-1.5 text-xs font-mono font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black transition-colors whitespace-nowrap shadow-sm flex items-center gap-1.5"
            title="Exportar Chamado ISP"
            aria-label="Exportar Chamado ISP"
          >
            <FileText className="w-4 h-4 xl:w-3.5 xl:h-3.5" />
            <span className="hidden xl:inline">Exportar Chamado ISP</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 space-y-5">
        <UpdateBanner />

        {/* Top Direct Answers Banner */}
        {hasMeasurement ? (
          <VerdictBanner
            verdict={verdict}
            metrics={metrics}
            isHairpinning={isHairpinning}
            endpoints={endpoints}
            traceroute={traceroute}
          />
        ) : (
          <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-6 text-center font-mono text-sm text-slate-400">
            Medindo a conexão com o xCloud... o veredito aparece assim que o primeiro alvo responder.
          </div>
        )}

        <NetworkMap2D
          isHairpinning={isHairpinning}
          rttMs={metrics.rttMs}
          className="min-h-[380px]"
        />

        {/* Mathematical Network Gauges (RFC 3550 Jitter, RTT, Loss, Bufferbloat) */}
        {hasMeasurement && (
          <TelemetryGauges
            metrics={metrics}
            rttHistory={rttHistory}
            jitterHistory={jitterHistory}
            lossHistory={lossHistory}
            onTriggerBufferbloat={handleTriggerBufferbloat}
            isTestingBufferbloat={isTestingBufferbloat}
            bufferbloatNote={bufferbloatNote}
          />
        )}


        {/* Simulation lab: injects fake metrics, so it only exists in dev builds */}
        {import.meta.env.DEV && (
          <SimulationControls
            onSimulateHairpinning={handleSimulateHairpinning}
            onSimulateBufferbloat={handleSimulateBufferbloat}
            onResetNominal={handleResetNominal}
            onTriggerBufferbloat={handleTriggerBufferbloat}
            isTestingBufferbloat={isTestingBufferbloat}
            activeSimulation={activeSimulation}
          />
        )}

        {/* Conditional Content based on activeTab */}
        {activeTab === 'dashboard' && (
          <div className="space-y-4">
            <StrategicMatrix
              endpoints={endpoints}
              customHostResult={customHostResult}
              onProbeCustomHost={handleProbeCustomHost}
              onClearCustomHost={handleClearCustomHost}
              isHairpinning={isHairpinning}
            />
            <RouteDiagnostics
              traceroute={traceroute}
              isHairpinning={isHairpinning}
            />
          </div>
        )}

        {activeTab === 'route' && (
          <RouteDiagnostics
            traceroute={traceroute}
            isHairpinning={isHairpinning}
          />
        )}

        {activeTab === 'servers' && (
          <div className="space-y-4">
            <StrategicMatrix
              endpoints={endpoints}
              customHostResult={customHostResult}
              onProbeCustomHost={handleProbeCustomHost}
              onClearCustomHost={handleClearCustomHost}
              isHairpinning={isHairpinning}
            />
          </div>
        )}

        {activeTab === 'history' && <HistoryView />}
      </main>

      {/* Footer */}
      <footer className="border-t border-cyan-950/60 bg-[#020508] px-4 py-4 text-center text-xs font-mono text-slate-500">
        xCloud Cyber-Monitor{appVersion ? ` · v${appVersion}` : ''}
      </footer>

      {/* Report Modal */}
      <ReportModal
        isOpen={isReportOpen}
        onClose={() => setIsReportOpen(false)}
        metrics={metrics}
        endpoints={endpoints}
        traceroute={traceroute}
        verdict={verdict}
      />

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </div>
  );
}

export default function App() {
  // The whole app is a front-end for the Rust backend: outside Tauri there is nothing to measure.
  return isTauriApp() ? <Dashboard /> : <DesktopOnlyNotice />;
}
