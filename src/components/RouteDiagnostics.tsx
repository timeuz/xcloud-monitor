import React from 'react';
import { RouteHop, TracerouteReport } from '../types/telemetry';
import { MapPin, ArrowRight, ShieldAlert, CheckCircle, HelpCircle, Network } from 'lucide-react';

interface RouteDiagnosticsProps {
  traceroute: TracerouteReport;
  isHairpinning: boolean;
}

export const RouteDiagnostics: React.FC<RouteDiagnosticsProps> = ({
  traceroute,
  isHairpinning,
}) => {
  const hasRoute = traceroute.hops.length > 0;
  return (
    <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-cyan-900/30">
        <div>
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold font-mono tracking-wide text-slate-100 uppercase">
              DIAGNÓSTICO DE ROTA HOP-BY-HOP // INSPEÇÃO TTL & BGP
            </h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Rastreamento de saltos entre seu roteador local e os servidores de streaming em São Paulo
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!hasRoute ? (
            <span className="px-2.5 py-1 rounded bg-slate-900 text-slate-300 border border-slate-600/50 text-xs font-mono flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
              <span>SEM DADOS DE ROTA</span>
            </span>
          ) : isHairpinning ? (
            <span className="px-2.5 py-1 rounded bg-red-950/80 text-red-300 border border-red-500/50 text-xs font-mono flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
              <span>ROTA SUBÓTIMA (EUA)</span>
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-500/50 text-xs font-mono flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
              <span>ROTA NACIONAL OTIMIZADA</span>
            </span>
          )}
        </div>
      </div>

      {/* Summary Callout */}
      <div
        className={`p-3 rounded-lg border text-xs font-mono ${
          !hasRoute
            ? 'bg-slate-900/60 border-slate-600/40 text-slate-300'
            : isHairpinning
            ? 'bg-red-950/20 border-red-500/40 text-red-200'
            : 'bg-emerald-950/20 border-emerald-500/40 text-emerald-200'
        }`}
      >
        <span className="font-bold">ANÁLISE DE ROTA: </span>
        <span>{traceroute.summary}</span>
        {traceroute.evidence && traceroute.evidence.length > 0 && (
          <ul className="mt-1.5 list-disc pl-4 space-y-0.5 text-[11px] opacity-90">
            {traceroute.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Interactive Hop Flow Visualizer */}
      <div className="space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          {traceroute.hops.map((hop, idx) => {
            const isAnomaly = hop.isAnomaly ?? (isHairpinning && hop.location.includes('EUA'));
            return (
              <div
                key={hop.ttl}
                className={`p-3 rounded-lg border flex flex-col justify-between transition-all ${
                  isAnomaly
                    ? 'bg-red-950/40 border-red-500/60 shadow-lg shadow-red-950/40'
                    : 'bg-[#03080d] border-cyan-950/80'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                    <span className="font-bold text-cyan-400">Salto #{hop.ttl}</span>
                    <span className={`font-bold tabular-nums ${isAnomaly ? 'text-red-400' : 'text-emerald-400'}`}>
                      {hop.rttMs.toFixed(1)} ms
                    </span>
                  </div>

                  <div className="mt-2 text-xs font-semibold text-slate-200 truncate" title={hop.host}>
                    {hop.host}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
                    {hop.ip}
                  </div>
                </div>

                <div className="mt-2.5 pt-2 border-t border-slate-800 text-[11px] font-mono flex items-center gap-1">
                  <MapPin className={`w-3 h-3 shrink-0 ${isAnomaly ? 'text-red-400' : 'text-cyan-400'}`} />
                  <span className={`truncate ${isAnomaly ? 'text-red-300 font-bold' : 'text-slate-400'}`}>
                    {hop.location}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {hasRoute && traceroute.measuredAt && (
          <p className="text-[10px] font-mono text-slate-500">
            Medido com {traceroute.source ?? 'traceroute'} às{' '}
            {new Date(traceroute.measuredAt).toLocaleTimeString('pt-BR')}
            {traceroute.reached === false ? ' · destino não respondeu ICMP' : ''}
          </p>
        )}
      </div>
    </div>
  );
};
