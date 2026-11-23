import React, { useEffect, useState } from 'react';
import { NetworkMetrics, ConnectionQuality } from '../types/telemetry';
import { Activity, Gauge, Flame, HardDrive, RefreshCw } from 'lucide-react';

interface TelemetryGaugesProps {
  metrics: NetworkMetrics;
  rttHistory: number[];
  jitterHistory: number[];
  lossHistory: number[];
  onTriggerBufferbloat: () => void;
  isTestingBufferbloat: boolean;
  /** Result summary or failure reason of the last bufferbloat test. */
  bufferbloatNote?: string;
}

function classifyQuality(metric: 'rtt' | 'jitter' | 'loss' | 'bufferbloat', value: number): ConnectionQuality {
  if (metric === 'rtt') {
    if (value < 20) return 'BOA';
    if (value <= 60) return 'ATENÇÃO';
    return 'RUIM';
  }
  if (metric === 'jitter') {
    if (value < 2) return 'BOA';
    if (value <= 10) return 'ATENÇÃO';
    return 'RUIM';
  }
  if (metric === 'loss') {
    if (value <= 0.001) return 'BOA';
    if (value <= 0.1) return 'ATENÇÃO';
    return 'RUIM';
  }
  if (metric === 'bufferbloat') {
    if (value < 10) return 'BOA';
    if (value <= 40) return 'ATENÇÃO';
    return 'RUIM';
  }
  return 'BOA';
}

function getQualityColor(quality: ConnectionQuality) {
  if (quality === 'BOA') return { text: 'text-emerald-400', border: 'border-emerald-500/40', bg: 'bg-emerald-500', pill: 'bg-emerald-950/80 text-emerald-300 border-emerald-500/30' };
  if (quality === 'ATENÇÃO') return { text: 'text-amber-400', border: 'border-amber-500/40', bg: 'bg-amber-500', pill: 'bg-amber-950/80 text-amber-300 border-amber-500/30' };
  return { text: 'text-red-400', border: 'border-red-500/40', bg: 'bg-red-500', pill: 'bg-red-950/80 text-red-300 border-red-500/30' };
}

// Mini SVG Sparkline Component
function Sparkline({ data, maxVal, color }: { data: number[]; maxVal: number; color: string }) {
  if (!data || data.length < 2) return <div className="h-6 w-full bg-slate-900/40 rounded"></div>;

  const width = 120;
  const height = 24;
  const points = data.slice(-16).map((val, idx, arr) => {
    const x = (idx / (arr.length - 1)) * width;
    const clamped = Math.min(val, maxVal);
    const y = height - (clamped / maxVal) * (height - 4) - 2;
    return `${x},${y}`;
  });

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points.join(' ')}
      />
    </svg>
  );
}

export const TelemetryGauges: React.FC<TelemetryGaugesProps> = ({
  metrics,
  rttHistory,
  jitterHistory,
  lossHistory,
  onTriggerBufferbloat,
  isTestingBufferbloat,
  bufferbloatNote,
}) => {
  // The test saturates the line and contacts Cloudflare, so it needs an explicit second click.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 6000);
    return () => clearTimeout(t);
  }, [confirming]);

  const rttQ = classifyQuality('rtt', metrics.rttMs);
  const jitterQ = classifyQuality('jitter', metrics.jitterMs);
  const lossQ = classifyQuality('loss', metrics.packetLossPct);
  const bloatQ = classifyQuality('bufferbloat', metrics.bufferbloatDeltaMs);

  const rttTheme = getQualityColor(rttQ);
  const jitterTheme = getQualityColor(jitterQ);
  const lossTheme = getQualityColor(lossQ);
  const bloatTheme = getQualityColor(bloatQ);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5">
      {/* 1. Latência RTT */}
      <div className={`rounded-xl border bg-[#06121c] p-4 ${rttTheme.border} flex flex-col justify-between shadow-lg`}>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5 uppercase">
              <Gauge className="w-3.5 h-3.5 text-cyan-400" />
              <span>Latência (RTT)</span>
            </span>
            <span className={`text-[11px] font-mono px-2 py-0.5 rounded border ${rttTheme.pill}`}>
              {rttQ}
            </span>
          </div>

          <div className="mt-3 flex items-baseline justify-between">
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl font-extrabold font-mono tabular-nums ${rttTheme.text}`}>
                {metrics.rttMs.toFixed(1)}
              </span>
              <span className="text-xs text-slate-400 font-mono">ms</span>
            </div>
            <Sparkline data={rttHistory} maxVal={160} color={rttQ === 'BOA' ? '#00ff66' : rttQ === 'ATENÇÃO' ? '#ffaa00' : '#ff003c'} />
          </div>

          {/* Progress gauge bar */}
          <div className="w-full h-1.5 bg-slate-800 rounded-full mt-3 overflow-hidden">
            <div
              className={`h-full ${rttTheme.bg} transition-all duration-300`}
              style={{ width: `${Math.min(100, (metrics.rttMs / 120) * 100)}%` }}
            />
          </div>
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs font-mono text-slate-400">
          <span>Média (SMA): <b className="text-slate-200">{metrics.rttAvgMs.toFixed(1)}ms</b></span>
          <span>Ideal: &lt; 20ms</span>
        </div>
      </div>

      {/* 2. Jitter RFC 3550 */}
      <div className={`rounded-xl border bg-[#06121c] p-4 ${jitterTheme.border} flex flex-col justify-between shadow-lg`}>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5 uppercase">
              <Activity className="w-3.5 h-3.5 text-cyan-400" />
              <span>Jitter (RFC 3550)</span>
            </span>
            <span className={`text-[11px] font-mono px-2 py-0.5 rounded border ${jitterTheme.pill}`}>
              {jitterQ}
            </span>
          </div>

          <div className="mt-3 flex items-baseline justify-between">
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl font-extrabold font-mono tabular-nums ${jitterTheme.text}`}>
                {metrics.jitterMs.toFixed(2)}
              </span>
              <span className="text-xs text-slate-400 font-mono">ms</span>
            </div>
            <Sparkline data={jitterHistory} maxVal={25} color={jitterQ === 'BOA' ? '#00ff66' : jitterQ === 'ATENÇÃO' ? '#ffaa00' : '#ff003c'} />
          </div>

          <div className="w-full h-1.5 bg-slate-800 rounded-full mt-3 overflow-hidden">
            <div
              className={`h-full ${jitterTheme.bg} transition-all duration-300`}
              style={{ width: `${Math.min(100, (metrics.jitterMs / 20) * 100)}%` }}
            />
          </div>
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs font-mono text-slate-400">
          <span>Filtro EWMA: 1/16</span>
          <span>Ideal: &lt; 2ms</span>
        </div>
      </div>

      {/* 3. Perda de Pacotes */}
      <div className={`rounded-xl border bg-[#06121c] p-4 ${lossTheme.border} flex flex-col justify-between shadow-lg`}>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5 uppercase">
              <HardDrive className="w-3.5 h-3.5 text-cyan-400" />
              <span>Perda de Pacotes</span>
            </span>
            <span className={`text-[11px] font-mono px-2 py-0.5 rounded border ${lossTheme.pill}`}>
              {lossQ}
            </span>
          </div>

          <div className="mt-3 flex items-baseline justify-between">
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl font-extrabold font-mono tabular-nums ${lossTheme.text}`}>
                {metrics.packetLossPct.toFixed(2)}
              </span>
              <span className="text-xs text-slate-400 font-mono">%</span>
            </div>
            <Sparkline data={lossHistory} maxVal={1.0} color={lossQ === 'BOA' ? '#00ff66' : lossQ === 'ATENÇÃO' ? '#ffaa00' : '#ff003c'} />
          </div>

          <div className="w-full h-1.5 bg-slate-800 rounded-full mt-3 overflow-hidden">
            <div
              className={`h-full ${lossTheme.bg} transition-all duration-300`}
              style={{ width: `${Math.min(100, (metrics.packetLossPct / 1.0) * 100)}%` }}
            />
          </div>
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs font-mono text-slate-400">
          <span>Pacotes: <b className="text-slate-200">{metrics.samplesLost}/{metrics.samplesSent}</b></span>
          <span>Ideal: 0.00%</span>
        </div>
      </div>

      {/* 4. Delta de Bufferbloat */}
      <div className={`rounded-xl border bg-[#06121c] p-4 ${bloatTheme.border} flex flex-col justify-between shadow-lg`}>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5 uppercase">
              <Flame className="w-3.5 h-3.5 text-cyan-400" />
              <span>Delta Bufferbloat</span>
            </span>
            <button
              onClick={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                setConfirming(false);
                onTriggerBufferbloat();
              }}
              disabled={isTestingBufferbloat}
              className="text-[11px] font-mono px-2 py-0.5 rounded bg-cyan-950/90 text-cyan-300 border border-cyan-800/50 hover:bg-cyan-900 transition-colors flex items-center gap-1"
              title="Satura a linha por ~25 s (download e upload) enquanto mede a latência. Usa até ~330 MB e conecta à Cloudflare. Não rode durante uma partida."
            >
              <RefreshCw className={`w-3 h-3 ${isTestingBufferbloat ? 'animate-spin' : ''}`} />
              <span>{isTestingBufferbloat ? 'Testando ~25 s...' : confirming ? 'Confirmar: ~330 MB, via Cloudflare' : 'Testar'}</span>
            </button>
          </div>

          <div className="mt-3 flex items-baseline justify-between">
            <div className="flex items-baseline gap-1">
              <span className={`text-3xl font-extrabold font-mono tabular-nums ${bloatTheme.text}`}>
                +{metrics.bufferbloatDeltaMs.toFixed(1)}
              </span>
              <span className="text-xs text-slate-400 font-mono">ms</span>
            </div>
            <span className={`text-xs font-mono px-2 py-0.5 rounded border ${bloatTheme.pill}`}>
              {bloatQ}
            </span>
          </div>

          <div className="w-full h-1.5 bg-slate-800 rounded-full mt-3 overflow-hidden">
            <div
              className={`h-full ${bloatTheme.bg} transition-all duration-300`}
              style={{ width: `${Math.min(100, (metrics.bufferbloatDeltaMs / 60) * 100)}%` }}
            />
          </div>
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs font-mono text-slate-400">
          <span>Sobrecarga: <b className="text-slate-200">RTT Loaded - Idle</b></span>
          <span>Ideal: &lt; 5ms</span>
        </div>
        {bufferbloatNote && (
          <p className="mt-2 text-[11px] font-mono text-cyan-300 break-words">{bufferbloatNote}</p>
        )}
      </div>
    </div>
  );
};
