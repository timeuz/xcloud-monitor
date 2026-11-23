import React, { useState } from 'react';
import { StrategicEndpoint } from '../types/telemetry';
import { Server, Globe, Search, PlusCircle, Check, X, ShieldAlert, Cpu } from 'lucide-react';
import { playUiClick } from '../services/soundEffects';

interface StrategicMatrixProps {
  endpoints: StrategicEndpoint[];
  customHostResult: { host: string; rttMs: number | null; online: boolean } | null;
  onProbeCustomHost: (host: string) => void;
  onClearCustomHost: () => void;
  isHairpinning: boolean;
}

export const StrategicMatrix: React.FC<StrategicMatrixProps> = ({
  endpoints,
  customHostResult,
  onProbeCustomHost,
  onClearCustomHost,
  isHairpinning,
}) => {
  const [inputHost, setInputHost] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'borda_brasil' | 'azure_brazilsouth' | 'ix_nacional' | 'referencia_internacional'>('all');

  const handleAddHost = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputHost.trim()) {
      playUiClick();
      onProbeCustomHost(inputHost.trim());
      setInputHost('');
    }
  };

  const filteredEndpoints = selectedFilter === 'all'
    ? endpoints
    : endpoints.filter((ep) => ep.category === selectedFilter);

  return (
    <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg space-y-4">
      {/* Top Header & Custom Host Input */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 pb-3 border-b border-cyan-900/30">
        <div>
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold font-mono tracking-wide text-slate-100 uppercase">
              MATRIZ DE ENDPOINTS ESTRATÉGICOS // AS8075 & AZURE
            </h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Sondagem simultânea dos PoPs de borda Microsoft Brasil, Datacenter brazilsouth e referências EUA
          </p>
        </div>

        {/* Custom Host Input form */}
        <form onSubmit={handleAddHost} className="flex items-center gap-2 w-full md:w-auto">
          <div className="relative flex-1 md:w-56">
            <input
              type="text"
              value={inputHost}
              onChange={(e) => setInputHost(e.target.value)}
              placeholder="Testar IP/Host (ex: 8.8.8.8)"
              className="w-full px-3 py-1.5 pl-8 text-xs font-mono bg-[#03080d] border border-cyan-900/60 rounded-lg text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400"
            />
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
          </div>
          <button
            type="submit"
            className="px-3 py-1.5 text-xs font-mono font-medium rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 transition-colors flex items-center gap-1 shrink-0"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>Adicionar</span>
          </button>
        </form>
      </div>

      {/* Category Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => {
            setSelectedFilter('all');
            playUiClick();
          }}
          className={`px-3 py-1 text-xs font-mono rounded transition-colors ${
            selectedFilter === 'all'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:text-slate-200 bg-[#040b12]'
          }`}
        >
          Todos ({endpoints.length})
        </button>
        <button
          onClick={() => {
            setSelectedFilter('borda_brasil');
            playUiClick();
          }}
          className={`px-3 py-1 text-xs font-mono rounded transition-colors ${
            selectedFilter === 'borda_brasil'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:text-slate-200 bg-[#040b12]'
          }`}
        >
          1. Borda Brasil AS8075
        </button>
        <button
          onClick={() => {
            setSelectedFilter('azure_brazilsouth');
            playUiClick();
          }}
          className={`px-3 py-1 text-xs font-mono rounded transition-colors ${
            selectedFilter === 'azure_brazilsouth'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:text-slate-200 bg-[#040b12]'
          }`}
        >
          2. Azure brazilsouth (SP)
        </button>
        <button
          onClick={() => {
            setSelectedFilter('ix_nacional');
            playUiClick();
          }}
          className={`px-3 py-1 text-xs font-mono rounded transition-colors ${
            selectedFilter === 'ix_nacional'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:text-slate-200 bg-[#040b12]'
          }`}
        >
          3. IX Nacionais
        </button>
        <button
          onClick={() => {
            setSelectedFilter('referencia_internacional');
            playUiClick();
          }}
          className={`px-3 py-1 text-xs font-mono rounded transition-colors ${
            selectedFilter === 'referencia_internacional'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:text-slate-200 bg-[#040b12]'
          }`}
        >
          4. Referência EUA (Hairpinning)
        </button>
      </div>

      {/* User Custom Host Card if Active */}
      {customHostResult && (
        <div className="p-2.5 rounded-lg bg-cyan-950/30 border border-cyan-500/40 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
            <span className="text-slate-400">Host Customizado:</span>
            <b className="text-cyan-300">{customHostResult.host}</b>
            <span className="text-slate-400">| RTT:</span>
            <b className="text-emerald-400">
              {customHostResult.rttMs !== null ? `${customHostResult.rttMs.toFixed(1)}ms` : 'TIMEOUT'}
            </b>
          </div>
          <button
            onClick={() => {
              playUiClick();
              onClearCustomHost();
            }}
            className="text-slate-400 hover:text-red-400 p-1 transition-colors"
            title="Remover host customizado"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Endpoints Table Grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs font-mono border-collapse">
          <thead>
            <tr className="border-b border-cyan-900/40 text-slate-400 font-semibold">
              <th className="py-2 px-3">CATEGORIA</th>
              <th className="py-2 px-3">ENDPOINT / IDENTIFICADOR</th>
              <th className="py-2 px-3">HOST / IP</th>
              <th className="py-2 px-3 text-right">RTT</th>
              <th className="py-2 px-3 text-center">STATUS</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {filteredEndpoints.map((ep) => {
              const isEua = ep.category === 'referencia_internacional';
              const rttFormatted = ep.rttMs !== null ? `${ep.rttMs.toFixed(1)}ms` : 'TIMEOUT';

              let statusBadge = (
                <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-500/30">
                  BOA
                </span>
              );
              if (isEua) {
                statusBadge = (
                  <span className="px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-500/30">
                    REF-EUA
                  </span>
                );
              } else if (ep.rttMs === null) {
                statusBadge = (
                  <span className="px-2 py-0.5 rounded bg-red-950 text-red-400 border border-red-500/30">
                    TIMEOUT
                  </span>
                );
              } else if (ep.rttMs > 65) {
                statusBadge = (
                  <span className="px-2 py-0.5 rounded bg-red-950 text-red-400 border border-red-500/30">
                    RUIM
                  </span>
                );
              } else if (ep.rttMs > 45) {
                statusBadge = (
                  <span className="px-2 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-500/30">
                    ATENÇÃO
                  </span>
                );
              }

              return (
                <tr key={ep.id} className="hover:bg-cyan-950/20 transition-colors">
                  <td className="py-2 px-3 text-slate-400">
                    {ep.category === 'borda_brasil' ? (
                      <span className="text-cyan-300">Borda BR</span>
                    ) : ep.category === 'azure_brazilsouth' ? (
                      <span className="text-emerald-300">Datacenter SP</span>
                    ) : ep.category === 'ix_nacional' ? (
                      <span className="text-purple-300">IX Nacional</span>
                    ) : (
                      <span className="text-amber-300">Ref. EUA</span>
                    )}
                  </td>
                  <td className="py-2 px-3 font-semibold text-slate-200">
                    {ep.label}
                  </td>
                  <td className="py-2 px-3 text-slate-400 text-[11px]">
                    {ep.host}
                  </td>
                  <td className="py-2 px-3 text-right font-bold tabular-nums text-slate-100">
                    {rttFormatted}
                  </td>
                  <td className="py-2 px-3 text-center">
                    {statusBadge}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Category 4: WebRTC In-Stream Stream UDP Banner */}
      <div className="p-3 rounded-lg bg-[#040b12] border border-cyan-900/30 flex items-center justify-between text-xs font-mono">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-emerald-400" />
          <span className="text-slate-300">
            4. In-Stream WebRTC UDP (Better xCloud / RTCPeerConnection H.264):
          </span>
          <span className="text-emerald-400 font-bold">104.44.239.10:3478</span>
        </div>
        <div className="flex items-center gap-3 text-slate-400">
          <span>Perda de Quadros: <b className="text-emerald-400">0.00%</b></span>
          <span>Frame Pacing: <b className="text-cyan-300">60 FPS Locked</b></span>
        </div>
      </div>
    </div>
  );
};
