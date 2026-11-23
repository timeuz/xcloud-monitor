import React from 'react';
import { GamingVerdict, NetworkMetrics, StrategicEndpoint, TracerouteReport } from '../types/telemetry';
import { CheckCircle2, AlertTriangle, XCircle, Clock, Zap, MapPin, Server, Wifi, Compass, Gauge } from 'lucide-react';

interface VerdictBannerProps {
  verdict: GamingVerdict;
  metrics: NetworkMetrics;
  isHairpinning: boolean;
  endpoints: StrategicEndpoint[];
  traceroute: TracerouteReport;
}

export const VerdictBanner: React.FC<VerdictBannerProps> = ({
  verdict,
  metrics,
  isHairpinning,
  endpoints,
  traceroute,
}) => {
  // Color tokens based on rank
  const getBadgeTheme = () => {
    switch (verdict.rank) {
      case 'S':
        return {
          bg: 'bg-emerald-950/40',
          border: 'border-emerald-500/40',
          text: 'text-emerald-400',
          badgeBg: 'bg-emerald-500 text-black',
          sub: 'Sensação idêntica a console local (60 FPS Lock)',
        };
      case 'A':
        return {
          bg: 'bg-cyan-950/40',
          border: 'border-cyan-500/40',
          text: 'text-cyan-400',
          badgeBg: 'bg-cyan-500 text-black',
          sub: 'Excelente fluidez para quase todos os jogos',
        };
      case 'B':
        return {
          bg: 'bg-amber-950/40',
          border: 'border-amber-500/40',
          text: 'text-amber-400',
          badgeBg: 'bg-amber-500 text-black',
          sub: 'Jogável com ressalvas (input lag perceptível em jogos rápidos)',
        };
      case 'F':
      default:
        return {
          bg: 'bg-red-950/40',
          border: 'border-red-500/40',
          text: 'text-red-400',
          badgeBg: 'bg-red-500 text-white',
          sub: 'Alta latência ou descarte severo de quadros (desfavorável)',
        };
    }
  };

  const theme = getBadgeTheme();
  const currentRtt = metrics.smoothedRttMs ?? metrics.rttMs;
  const gateway = endpoints.find((e) => e.id === 'local_gateway');
  const ispHop = endpoints.find((e) => e.id === 'isp_hop1');
  const gatewayRtt = gateway?.online ? gateway.rttMs : null;
  const ispRtt = ispHop?.online ? ispHop.rttMs : null;
  const bloat = metrics.bufferbloatDeltaMs;
  const routeMeasured = traceroute.hopCount > 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
      {/* Card 1: Veredito: É um momento bom para jogar? */}
      <div className={`rounded-xl border p-4 ${theme.bg} ${theme.border} flex flex-col justify-between`}>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-cyan-400" />
              <span>MOMENTO PARA JOGAR</span>
            </span>
            <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${theme.badgeBg}`}>
              RANK {verdict.rank}
            </span>
          </div>

          <div className="mt-3">
            <h3 className={`text-lg font-bold ${theme.text}`}>
              {verdict.headline}
            </h3>
            <p className="text-[11px] font-mono leading-relaxed text-slate-400 mt-1.5">
              {theme.sub}
            </p>
          </div>
        </div>

        {metrics.resilience && (
          <div className="mt-2 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] font-mono">
            <span className="text-slate-400">Resiliência (N=10):</span>
            <span className="text-cyan-300 font-semibold">
              {metrics.resilience.trend} ({metrics.resilience.stabilityScore}% estabilidade)
            </span>
          </div>
        )}
      </div>

      {/* Card 2: Minha Conexão ou Servidores Microsoft? */}
      <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-cyan-400" />
              <span>MINHA REDE vs MICROSOFT</span>
            </span>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/40">
              ISOLAMENTO
            </span>
          </div>

          <div className="mt-3 space-y-2.5 leading-relaxed">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400 flex items-center gap-1">
                <Gauge className="w-3.5 h-3.5 text-slate-400" /> Latência RTT:
              </span>
              <span
                className={`font-semibold ${
                  currentRtt >= 65
                    ? 'text-red-400'
                    : currentRtt >= 45
                    ? 'text-amber-400'
                    : 'text-emerald-400'
                }`}
              >
                {currentRtt.toFixed(1)} ms ({currentRtt >= 65 ? 'Crítica' : currentRtt >= 45 ? 'Elevada' : 'Excelente'})
              </span>
            </div>

            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400 flex items-center gap-1">
                <Wifi className="w-3.5 h-3.5 text-slate-400" /> Roteador:
              </span>
              <span className={`font-semibold ${gatewayRtt == null ? 'text-slate-500' : gatewayRtt >= 15 ? 'text-red-400' : gatewayRtt >= 5 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {gatewayRtt == null ? 'não medido' : `${gatewayRtt.toFixed(1)} ms`}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400 flex items-center gap-1">
                <Server className="w-3.5 h-3.5 text-slate-400" /> 1º salto da operadora:
              </span>
              <span className={`font-semibold ${ispRtt == null ? 'text-slate-500' : 'text-slate-200'}`}>
                {ispRtt == null ? 'não medido' : `${ispRtt.toFixed(1)} ms`}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400 flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-slate-400" /> Bufferbloat:
              </span>
              <span className={`font-semibold ${bloat == null ? 'text-slate-500' : bloat > 35 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {bloat == null ? 'não testado' : `+${bloat.toFixed(1)} ms`}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-cyan-900/30 text-[11px] font-mono leading-relaxed">
          <span className="text-slate-400">Origem: </span>
          <span className="font-semibold text-slate-200">
            {verdict.rootCauseCategory === 'LOCAL_CONNECTION'
              ? 'Problema na Rede Local / Roteador'
              : verdict.rootCauseCategory === 'ISP_ROUTE'
              ? 'Problema na Operadora / Rota BGP'
              : 'Nenhum gargalo detectado nas medições'}
          </span>
        </div>
      </div>

      {/* Card 3: Problema de Rota ou Algo mais Local? */}
      <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Compass className="w-3.5 h-3.5 text-cyan-400" />
              <span>ROTA ATÉ O XCLOUD</span>
            </span>
            <span
              className={`text-[11px] font-mono px-2 py-0.5 rounded font-bold ${
                isHairpinning
                  ? 'bg-red-500 text-white'
                  : routeMeasured
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/40'
                  : 'bg-slate-900 text-slate-400 border border-slate-700'
              }`}
            >
              {isHairpinning ? 'DESVIO P/ EUA' : routeMeasured ? 'SEM DESVIO' : 'AGUARDANDO'}
            </span>
          </div>

          <div className="mt-2.5">
            {isHairpinning ? (
              <div className="space-y-2">
                <div className="text-sm font-bold text-red-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  <span>Desvio Internacional (Hairpinning)</span>
                </div>
                <p className="text-[11px] font-mono leading-relaxed text-slate-400">
                  Seus dados viajam para os EUA (Miami/Atlanta) antes de chegar a São Paulo. A culpa é do roteamento da sua operadora!
                </p>
              </div>
            ) : routeMeasured ? (
              <div className="space-y-2">
                <div className="text-sm font-bold text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Sem desvio para fora do Brasil</span>
                </div>
                <p className="text-[11px] font-mono leading-relaxed text-slate-400">
                  Rota medida com {traceroute.hopCount} saltos{traceroute.reached ? ' até o destino' : ' (o destino não respondeu ao traceroute)'}.
                  {traceroute.detectedPop ? ` Ponto de entrada detectado: ${traceroute.detectedPop}.` : ''}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-sm font-bold text-slate-300">Rota ainda não medida</div>
                <p className="text-[11px] font-mono leading-relaxed text-slate-400">{traceroute.summary}</p>
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-cyan-900/30 flex items-center justify-between text-xs font-mono">
          <span className="text-slate-400">Saltos até o xCloud:</span>
          <span className="font-bold text-cyan-300">{routeMeasured ? traceroute.hopCount : '—'}</span>
        </div>
      </div>
    </div>
  );
};
