import React from 'react';
import { Settings, ShieldCheck, X } from 'lucide-react';
import { HistorySettings } from './HistorySettings';
import { UpdateSettings } from './UpdateSettings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-lg rounded-2xl border border-cyan-800/60 bg-[#06111a] shadow-2xl max-h-[90vh] overflow-y-auto font-mono text-slate-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-cyan-900/40 bg-[#030910]">
          <div className="flex items-center gap-2.5">
            <Settings className="w-5 h-5 text-cyan-400" />
            <h2 className="text-sm font-bold tracking-wide uppercase text-slate-100">Configurações</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 transition-colors"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 text-xs">
          <HistorySettings />
          <UpdateSettings />

          <div className="p-3.5 rounded-xl bg-[#040e17] border border-cyan-950/80 space-y-2">
            <div className="flex items-center gap-2 text-cyan-300 font-bold">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Privacidade</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              As medições ficam só neste computador. Saem da máquina apenas as sondagens aos alvos, o teste de bufferbloat (que você confirma) e a
              verificação de atualizações no GitHub.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
