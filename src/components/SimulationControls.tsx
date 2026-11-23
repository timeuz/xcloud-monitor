import React from 'react';
import { Sliders, RotateCcw, AlertTriangle, Wifi, Flame, Server, Play, Zap } from 'lucide-react';
import { playUiClick } from '../services/soundEffects';

interface SimulationControlsProps {
  onSimulateHairpinning: () => void;
  onSimulateWifi: () => void;
  onSimulateBufferbloat: () => void;
  onSimulateServerLoad: () => void;
  onResetNominal: () => void;
  onTriggerBufferbloat: () => void;
  isTestingBufferbloat: boolean;
  activeSimulation: string | null;
}

export const SimulationControls: React.FC<SimulationControlsProps> = ({
  onSimulateHairpinning,
  onSimulateWifi,
  onSimulateBufferbloat,
  onSimulateServerLoad,
  onResetNominal,
  onTriggerBufferbloat,
  isTestingBufferbloat,
  activeSimulation,
}) => {
  return (
    <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg space-y-3">
      <div className="flex items-center justify-between pb-2 border-b border-cyan-900/30">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm font-bold font-mono tracking-wide text-slate-100 uppercase">
            LABORATÓRIO DE SIMULAÇÃO & TESTES DE ENGENHARIA
          </h3>
        </div>
        <button
          onClick={() => {
            playUiClick();
            onResetNominal();
          }}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-mono font-medium rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Restaurar Condições Ideais (Rank S)</span>
        </button>
      </div>

      <p className="text-xs text-slate-400">
        Teste como o sistema reage e isola cada tipo de falha em tempo real (veja a resposta do Co-Piloto e os gráficos):
      </p>

      {/* Button Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {/* 1. Hairpinning BGP */}
        <button
          onClick={() => {
            playUiClick();
            onSimulateHairpinning();
          }}
          className={`p-2.5 rounded-lg border text-left text-xs font-mono transition-all flex flex-col justify-between gap-1.5 ${
            activeSimulation === 'hairpinning'
              ? 'bg-red-950/60 border-red-500 text-red-200 ring-1 ring-red-500'
              : 'bg-[#040b12] border-cyan-950 hover:border-red-500/40 text-slate-300'
          }`}
        >
          <div className="flex items-center gap-1.5 font-bold text-red-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>1. Rota BGP EUA</span>
          </div>
          <span className="text-[11px] text-slate-400 leading-tight">
            Desvio para Miami/Atlanta (135ms)
          </span>
        </button>

        {/* 2. Wi-Fi 2.4GHz */}
        <button
          onClick={() => {
            playUiClick();
            onSimulateWifi();
          }}
          className={`p-2.5 rounded-lg border text-left text-xs font-mono transition-all flex flex-col justify-between gap-1.5 ${
            activeSimulation === 'wifi'
              ? 'bg-amber-950/60 border-amber-500 text-amber-200 ring-1 ring-amber-500'
              : 'bg-[#040b12] border-cyan-950 hover:border-amber-500/40 text-slate-300'
          }`}
        >
          <div className="flex items-center gap-1.5 font-bold text-amber-400">
            <Wifi className="w-3.5 h-3.5" />
            <span>2. Wi-Fi 2.4 GHz</span>
          </div>
          <span className="text-[11px] text-slate-400 leading-tight">
            Interferência & Jitter alto (&gt;15ms)
          </span>
        </button>

        {/* 3. Bufferbloat */}
        <button
          onClick={() => {
            playUiClick();
            onSimulateBufferbloat();
          }}
          className={`p-2.5 rounded-lg border text-left text-xs font-mono transition-all flex flex-col justify-between gap-1.5 ${
            activeSimulation === 'bufferbloat'
              ? 'bg-amber-950/60 border-amber-500 text-amber-200 ring-1 ring-amber-500'
              : 'bg-[#040b12] border-cyan-950 hover:border-amber-500/40 text-slate-300'
          }`}
        >
          <div className="flex items-center gap-1.5 font-bold text-amber-400">
            <Flame className="w-3.5 h-3.5" />
            <span>3. Bufferbloat</span>
          </div>
          <span className="text-[11px] text-slate-400 leading-tight">
            Fila saturada no roteador (+68ms)
          </span>
        </button>

        {/* 4. Sobrecarga Servidor Microsoft */}
        <button
          onClick={() => {
            playUiClick();
            onSimulateServerLoad();
          }}
          className={`p-2.5 rounded-lg border text-left text-xs font-mono transition-all flex flex-col justify-between gap-1.5 ${
            activeSimulation === 'server_load'
              ? 'bg-amber-950/60 border-amber-500 text-amber-200 ring-1 ring-amber-500'
              : 'bg-[#040b12] border-cyan-950 hover:border-cyan-500/40 text-slate-300'
          }`}
        >
          <div className="flex items-center gap-1.5 font-bold text-cyan-400">
            <Server className="w-3.5 h-3.5" />
            <span>4. Fila no Servidor</span>
          </div>
          <span className="text-[11px] text-slate-400 leading-tight">
            Horário de pico &gt; 92% e filas
          </span>
        </button>
      </div>
    </div>
  );
};
