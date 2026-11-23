import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  NetworkMetrics,
  StrategicEndpoint,
  TracerouteReport,
  XCloudServerStatus,
  GamingVerdict,
  GamingRank,
  LiveGameQueue,
} from './types/telemetry';
import { NetworkMap2D } from './components/NetworkMap2D';
import { RobotMascot } from './components/RobotMascot';
import { VerdictBanner } from './components/VerdictBanner';
import { TelemetryGauges } from './components/TelemetryGauges';
import { StrategicMatrix } from './components/StrategicMatrix';
import { RouteDiagnostics } from './components/RouteDiagnostics';
import { SimulationControls } from './components/SimulationControls';
import { ActiveGameQueueWidget } from './components/ActiveGameQueueWidget';
import { ReportModal } from './components/ReportModal';
import { HistoryView } from './components/HistoryView';
import { UpdateBanner } from './components/UpdateBanner';
import { DesktopOnlyNotice } from './components/DesktopOnlyNotice';
import { computeVerdict, rawRankWithHysteresis } from './domain/verdict';
import { FORCED_HAIRPIN, nextHairpinState, smoothRtt } from './domain/telemetry';
import { SettingsModal } from './components/SettingsModal';
import { playUiClick } from './services/soundEffects';
import {
  fetchTelemetryProbe,
  fetchXCloudStatus,
  executeBufferbloatTest,
  fetchTracerouteReport,
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
  Globe,
  Radio,
  Settings,
} from 'lucide-react';

function Dashboard() {
  // Navigation & View Tab State
  const [activeTab, setActiveTab] = useState<'dashboard' | 'route' | 'servers' | 'history' | 'globe'>('dashboard');
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [aiRefreshTrigger, setAiRefreshTrigger] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTestingBufferbloat, setIsTestingBufferbloat] = useState(false);
  const [activeSimulation, setActiveSimulation] = useState<string | null>(null);

  // Core Metrics State
  const [metrics, setMetrics] = useState<NetworkMetrics>({
    rttMs: 35.4,
    rttAvgMs: 35.4,
    smoothedRttMs: 35.4,
    jitterMs: 0.15,
    smoothedJitterMs: 0.15,
    packetLossPct: 0.0,
    bufferbloatDeltaMs: 1.8,
    samplesSent: 12,
    samplesLost: 0,
    isWifi24Ghz: false,
    ttlHops: 5,
    decodeTimeMs: 4.2,
  });

  const [rttHistory, setRttHistory] = useState<number[]>([35.4, 35.6, 35.3, 35.5, 35.4, 35.2, 35.4]);
  const [jitterHistory, setJitterHistory] = useState<number[]>([0.2, 0.15, 0.18, 0.14, 0.15, 0.12, 0.15]);
  const [lossHistory, setLossHistory] = useState<number[]>([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);

  // Resilient Statistical Filtering, Sliding Window & Confirmation Refs
  // Rolling window of probe outcomes (1 = no answer) used to compute real packet loss
  const lossWindowRef = useRef<number[]>([]);
  const rttWindowRef = useRef<number[]>([35.4, 35.6, 35.3, 35.5, 35.4, 35.2, 35.4]);
  const jitterWindowRef = useRef<number[]>([0.2, 0.15, 0.18, 0.14, 0.15, 0.12, 0.15]);
  const confirmedHairpinningRef = useRef(false);
  const consecutiveHairpinningCountRef = useRef(0);
  const consecutiveNormalCountRef = useRef(0);
  const isProbingRef = useRef(false);
  const candidateRankRef = useRef<{ rank: GamingRank; count: number }>({ rank: 'S', count: 0 });
  const [stableRank, setStableRank] = useState<GamingRank>('S');

  // Strategic Endpoints State (Directly calibrated with xcloud.sh targets)
  const [endpoints, setEndpoints] = useState<StrategicEndpoint[]>([
    { id: 'xcloud_brs_direct', label: 'Cluster Brasil Sul (IP Direto)', host: '191.235.228.36', category: 'azure_brazilsouth', rttMs: 35.4, online: true, status: 'BOA' },
    { id: 'xcloud_gssv_prod', label: 'xCloud Streaming (GSSV Prod)', host: 'xgpu.gssv-play-prod.xboxlive.com', category: 'azure_brazilsouth', rttMs: 35.6, online: true, status: 'BOA' },
    { id: 'xcloud_gssv_web', label: 'xCloud Web F2P (GSSV Web)', host: 'xgpuwebf2p.gssv-play-prod.xboxlive.com', category: 'azure_brazilsouth', rttMs: 35.4, online: true, status: 'BOA' },
    { id: 'ix_sp_v4_1', label: 'IX.br SP IPv4 #1 (AS8075)', host: '187.16.218.144', category: 'borda_brasil', rttMs: 35.5, online: true, status: 'BOA' },
    { id: 'ix_sp_v4_2', label: 'IX.br SP IPv4 #2 (AS8075)', host: '187.16.218.139', category: 'borda_brasil', rttMs: 35.3, online: true, status: 'BOA' },
    { id: 'equinix_sp_v4_1', label: 'Equinix SP Barueri SP1-4', host: '64.191.233.147', category: 'borda_brasil', rttMs: 36.1, online: true, status: 'BOA' },
    { id: 'ix_rj', label: 'IX.br Rio de Janeiro', host: '45.68.80.73', category: 'ix_nacional', rttMs: 22.4, online: true, status: 'BOA' },
    { id: 'ix_campinas', label: 'IX.br Campinas', host: '200.192.108.42', category: 'ix_nacional', rttMs: 34.8, online: true, status: 'BOA' },
    { id: 'ix_fortaleza', label: 'IX.br Fortaleza', host: '45.68.74.84', category: 'ix_nacional', rttMs: 58.2, online: true, status: 'ATENÇÃO' },
    { id: 'us_equinix_miami', label: 'Ref. EUA: Equinix Miami', host: '198.32.242.188', category: 'referencia_internacional', rttMs: 118.5, online: true, status: 'REF-EUA' },
    { id: 'us_equinix_atlanta', label: 'Ref. EUA: Equinix Atlanta (CIX-ATL)', host: '198.32.182.105', category: 'referencia_internacional', rttMs: 134.0, online: true, status: 'REF-EUA' },
    { id: 'us_equinix_ashburn', label: 'Ref. EUA: Equinix Ashburn (IX-2572)', host: '206.126.236.148', category: 'referencia_internacional', rttMs: 142.6, online: true, status: 'REF-EUA' },
  ]);

  const [customHostResult, setCustomHostResult] = useState<{ host: string; rttMs: number | null; online: boolean } | null>(null);

  // Server & Queue State
  const [serverStatus, setServerStatus] = useState<XCloudServerStatus>({
    region: 'brazilsouth (São Paulo)',
    regionStatus: 'ONLINE_OPTIMAL',
    dataCenter: 'Azure São Paulo Campus (Barueri / Campinas / Vinhedo)',
    serverLoadPercentage: 42,
    estimatedWaitMinutes: 0,
    queueRisk: 'NONE',
    queueMessage: 'Sem filas identificadas. Servidores operando com folga de capacidade.',
    currentHourBRT: '14:30',
    peeringHealth: '100% PNI & IX.br Operacionais',
  });

  // Active Game Live Queue (from xStreaming / Azure)
  const [activeGameQueue, setActiveGameQueue] = useState<LiveGameQueue | null>(null);

  const handleQueueUpdated = useCallback((queue: LiveGameQueue) => {
    setActiveGameQueue(queue);
    setServerStatus((prev) => ({
      ...prev,
      estimatedWaitMinutes: queue.estimatedWaitMinutes,
      queueRisk: queue.estimatedWaitMinutes > 5 ? 'HIGH' : queue.estimatedWaitMinutes > 0.5 ? 'MEDIUM' : 'NONE',
      queueMessage: queue.estimatedWaitMinutes > 0
        ? `Fila oficial de ${queue.estimatedWaitMinutes} min para ${queue.titleName}.`
        : `Servidor alocando ${queue.titleName} imediatamente.`,
    }));
  }, []);

  // Traceroute State
  const [traceroute, setTraceroute] = useState<TracerouteReport>({
    target: '191.235.228.36 (xCloud Cluster Brasil Sul)',
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


  const rawVerdict = computeVerdict({ metrics, isHairpinning, serverStatus });
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
          setMetrics((prev) => {
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
              stableRank,
              nextSmoothedRtt,
              nextSmoothedJitter,
              prev.packetLossPct,
              prev.isWifi24Ghz,
              prev.bufferbloatDeltaMs,
              confirmedHairpinningRef.current,
              serverStatus.serverLoadPercentage,
              serverStatus.queueRisk
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

            if (candidateRankRef.current.count >= requiredConfirmations) {
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
  }, [activeSimulation, metrics.jitterMs, metrics.packetLossPct, stableRank, serverStatus, traceroute.isHairpinning]);

  // Periodic Server Status Fetch
  const fetchServerStatus = useCallback(async () => {
    try {
      const data = await fetchXCloudStatus();
      if (data) {
        setServerStatus((prev) => ({
          ...prev,
          ...data,
        }));
      }
    } catch (e) {
      // Ignore
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
    fetchServerStatus();

    const interval = setInterval(() => {
      fetchTelemetry();
    }, 4000);

    const statusInterval = setInterval(() => {
      fetchServerStatus();
    }, 15000);

    return () => {
      clearInterval(interval);
      clearInterval(statusInterval);
    };
  }, [fetchTelemetry, fetchServerStatus]);

  // Active Bufferbloat Burst Runner
  const [bufferbloatNote, setBufferbloatNote] = useState('');

  const handleTriggerBufferbloat = async () => {
    setIsTestingBufferbloat(true);
    playUiClick();

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
      setCustomHostResult({ host, rttMs: 15.2, online: true });
    }
  };

  const handleClearCustomHost = () => {
    setCustomHostResult(null);
  };

  // Simulation Levers - Sound triggers exclusively via verdict.rank transition effect
  const handleSimulateHairpinning = () => {
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
      ttlHops: 7,
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

  const handleSimulateWifi = () => {
    setActiveSimulation('wifi');
    setStableRank('B');
    setMetrics((prev) => ({
      ...prev,
      isWifi24Ghz: true,
      jitterMs: 18.6,
      smoothedJitterMs: 18.6,
      packetLossPct: 0.12,
    }));
  };

  const handleSimulateBufferbloat = () => {
    setActiveSimulation('bufferbloat');
    setStableRank('B');
    setMetrics((prev) => ({
      ...prev,
      bufferbloatDeltaMs: 68.4,
    }));
  };

  const handleSimulateServerLoad = () => {
    setActiveSimulation('server_load');
    setStableRank('B');
    setServerStatus((prev) => ({
      ...prev,
      serverLoadPercentage: 94,
      estimatedWaitMinutes: 12,
      queueRisk: 'HIGH',
      queueMessage: 'Horário de Pico Severo (Fim de Semana à noite). Fila estimada de 12 minutos para alocar console Xbox Series X.',
    }));
  };

  const handleResetNominal = () => {
    rttWindowRef.current = [35.4, 35.6, 35.3, 35.5, 35.4, 35.2, 35.4];
    jitterWindowRef.current = [0.2, 0.15, 0.18, 0.14, 0.15, 0.12, 0.15];
    confirmedHairpinningRef.current = false;
    consecutiveHairpinningCountRef.current = 0;
    consecutiveNormalCountRef.current = 0;
    candidateRankRef.current = { rank: 'S', count: 5 };
    setActiveSimulation(null);
    setStableRank('S');
    setMetrics({
      rttMs: 35.4,
      rttAvgMs: 35.4,
      smoothedRttMs: 35.4,
      jitterMs: 0.15,
      smoothedJitterMs: 0.15,
      packetLossPct: 0.0,
      bufferbloatDeltaMs: 1.8,
      samplesSent: 24,
      samplesLost: 0,
      isWifi24Ghz: false,
      ttlHops: 5,
      decodeTimeMs: 4.1,
      resilience: {
        trend: 'ESTÁVEL',
        stabilityScore: 98,
        windowSampleCount: 7,
        confirmedCycles: 5,
      },
    });
    refreshTraceroute();
    setServerStatus((prev) => ({
      ...prev,
      serverLoadPercentage: 38,
      estimatedWaitMinutes: 0,
      queueRisk: 'NONE',
      queueMessage: 'Sem filas identificadas. Servidores operando com folga de capacidade.',
    }));
  };

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    playUiClick();
    await Promise.all([fetchTelemetry(), fetchServerStatus()]);
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
              {isTauriApp() && (
                <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold tracking-wider">
                  DESKTOP TAURI v2
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Zone 2: Navigation Links / View Switcher */}
        <nav className="hidden md:flex items-center gap-2 text-xs font-mono font-medium text-slate-400">
          <button
            onClick={() => {
              setActiveTab('dashboard');
              playUiClick();
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
              playUiClick();
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
              playUiClick();
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'servers'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'hover:text-slate-200'
            }`}
          >
            Servidores & Filas
          </button>
          <button
            onClick={() => {
              setActiveTab('history');
              playUiClick();
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'history'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'hover:text-slate-200'
            }`}
          >
            Histórico
          </button>
          <button
            onClick={() => {
              setActiveTab('globe');
              playUiClick();
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'globe'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'hover:text-slate-200'
            }`}
          >
            Mapa de Rotas
          </button>
        </nav>

        {/* Zone 3: Primary Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => {
              playUiClick();
              setIsSettingsOpen(true);
            }}
            className="p-2 rounded-lg bg-cyan-950/40 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-800/40 transition-colors"
            title="Configurações da Chave OpenAI"
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
              playUiClick();
              setIsReportOpen(true);
            }}
            className="px-3.5 py-1.5 text-xs font-mono font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black transition-colors whitespace-nowrap shadow-sm flex items-center gap-1.5"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Exportar Chamado ISP</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 space-y-5">
        <UpdateBanner />

        {/* Top Direct Answers Banner */}
        <VerdictBanner
          verdict={verdict}
          serverStatus={serverStatus}
          metrics={metrics}
          isHairpinning={isHairpinning}
        />

        {/* Live Active Game Queue & Catalog Search Widget */}
        <ActiveGameQueueWidget onQueueUpdated={handleQueueUpdated} />

        {/* Robot Mascot & 2D Tactical World Map Split */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          <div className="lg:col-span-6 flex flex-col">
            <RobotMascot
              verdict={verdict}
              metrics={metrics}
              serverStatus={serverStatus}
              isHairpinning={isHairpinning}
              endpoints={endpoints}
              traceroute={traceroute}
              onOpenSettings={() => setIsSettingsOpen(true)}
              refreshTrigger={aiRefreshTrigger}
            />
          </div>
          <div className="lg:col-span-6 flex flex-col">
            <NetworkMap2D
              isHairpinning={isHairpinning}
              rttMs={metrics.rttMs}
              className="h-full min-h-[380px]"
            />
          </div>
        </div>

        {/* Mathematical Network Gauges (RFC 3550 Jitter, RTT, Loss, Bufferbloat) */}
        <TelemetryGauges
          metrics={metrics}
          rttHistory={rttHistory}
          jitterHistory={jitterHistory}
          lossHistory={lossHistory}
          onTriggerBufferbloat={handleTriggerBufferbloat}
          isTestingBufferbloat={isTestingBufferbloat}
          bufferbloatNote={bufferbloatNote}
        />


        {/* Simulation lab: injects fake metrics, so it only exists in dev builds */}
        {import.meta.env.DEV && (
          <SimulationControls
            onSimulateHairpinning={handleSimulateHairpinning}
            onSimulateWifi={handleSimulateWifi}
            onSimulateBufferbloat={handleSimulateBufferbloat}
            onSimulateServerLoad={handleSimulateServerLoad}
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
            <ActiveGameQueueWidget onQueueUpdated={handleQueueUpdated} />
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

        {activeTab === 'globe' && (
          <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-2 border-b border-cyan-900/30 gap-2">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm font-bold font-mono tracking-wide text-slate-100 uppercase">
                  MAPA TÁTICO DE ROTAS E CABOS SUBMARINOS // AS8075 & EUA
                </h3>
              </div>
            </div>
            <p className="text-xs text-slate-400">
              Visualização de rotas com pacotes em tempo real. Observe o enlace submarino (Monet / Seabras-1) ligando o Brasil aos servidores de referência em Miami, Atlanta e Ashburn nos Estados Unidos. Passe o mouse ou clique sobre qualquer nó para inspecionar telemetria detalhada.
            </p>
            <NetworkMap2D
              isHairpinning={isHairpinning}
              rttMs={metrics.rttMs}
              className="h-[520px]"
            />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-cyan-950/60 bg-[#020508] px-4 py-4 text-center text-xs font-mono text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>
            xCloud Cyber-Monitor · Desenvolvido com base na especificação técnica XCLOUD.md & r/xcloud
          </span>
          <span className="text-slate-400">
            AS8075 Microsoft Borda Brasil · IX.br SP (AS26162) · Azure brazilsouth
          </span>
        </div>
      </footer>

      {/* Report Modal */}
      <ReportModal
        isOpen={isReportOpen}
        onClose={() => setIsReportOpen(false)}
        metrics={metrics}
        endpoints={endpoints}
        traceroute={traceroute}
        serverStatus={serverStatus}
        verdict={verdict}
      />

      {/* OpenAI Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onKeySaved={() => setAiRefreshTrigger((prev) => prev + 1)}
      />
    </div>
  );
}

export default function App() {
  // The whole app is a front-end for the Rust backend: outside Tauri there is nothing to measure.
  return isTauriApp() ? <Dashboard /> : <DesktopOnlyNotice />;
}
