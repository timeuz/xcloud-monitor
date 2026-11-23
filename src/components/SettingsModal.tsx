import React, { useState, useEffect } from 'react';
import {
  Settings,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Trash2,
  ExternalLink,
  X,
  Loader2,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { playUiClick } from '../services/soundEffects';
import { HistorySettings } from './HistorySettings';
import { UpdateSettings } from './UpdateSettings';
import { fetchAiStatus, isTauriApp, saveAiKey, verifyAiKey } from '../services/nativeBridge';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onKeySaved?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onKeySaved,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{
    type: 'success' | 'error' | null;
    message: string;
  }>({ type: null, message: '' });
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Load existing key from localStorage on open
  useEffect(() => {
    if (isOpen) {
      // Desktop keeps the key in the OS keychain and never exposes it back to the UI.
      const stored = isTauriApp() ? '' : localStorage.getItem('xcloud_openai_api_key') || '';
      setApiKey(stored);
      setVerifyStatus({ type: null, message: '' });
      setSavedSuccess(false);
      if (isTauriApp()) {
        fetchAiStatus()
          .then((st) => {
            if (st.enabled) {
              setVerifyStatus({
                type: 'success',
                message: 'Chave já configurada no keychain do sistema. Cole outra para substituí-la.',
              });
            }
          })
          .catch(() => {});
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleVerify = async () => {
    playUiClick();
    const cleanKey = apiKey.trim();
    if (!cleanKey) {
      setVerifyStatus({
        type: 'error',
        message: 'Por favor, insira uma chave de API antes de testar.',
      });
      return;
    }

    setIsVerifying(true);
    setVerifyStatus({ type: null, message: '' });

    try {
      const data = await verifyAiKey(cleanKey);
      if (data.valid) {
        setVerifyStatus({
          type: 'success',
          message: data.message || 'Chave validada com sucesso na OpenAI!',
        });
      } else {
        setVerifyStatus({
          type: 'error',
          message: data.message || 'Chave rejeitada pela OpenAI. Verifique se o saldo e a chave estão ativos.',
        });
      }
    } catch (err: any) {
      setVerifyStatus({
        type: 'error',
        message: err?.message || 'Falha de conexão ao tentar validar com a OpenAI.',
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSave = async () => {
    playUiClick();
    const cleanKey = apiKey.trim();
    try {
      await saveAiKey(cleanKey);
    } catch (err: any) {
      setVerifyStatus({
        type: 'error',
        message: `Não foi possível salvar a chave: ${err?.message || err}`,
      });
      return;
    }

    setSavedSuccess(true);
    onKeySaved?.();

    setTimeout(() => {
      onClose();
    }, 900);
  };

  const handleRemove = async () => {
    playUiClick();
    setApiKey('');
    setVerifyStatus({
      type: 'success',
      message: 'Chave removida. O assistente operará no modo de diagnóstico local (sem IA).',
    });

    try {
      await saveAiKey('');
    } catch {}

    onKeySaved?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-lg rounded-2xl border border-cyan-800/60 bg-[#06111a] shadow-2xl max-h-[90vh] overflow-y-auto font-mono text-slate-200">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cyan-900/40 bg-[#030910]">
          <div className="flex items-center gap-2.5">
            <Settings className="w-5 h-5 text-cyan-400" />
            <div>
              <h2 className="text-sm font-bold tracking-wide uppercase text-slate-100">
                CONFIGURAÇÕES // INTELIGÊNCIA ARTIFICIAL
              </h2>
              <p className="text-[11px] text-slate-400">
                Gerencie sua chave de API OpenAI para análise generativa e voz neural
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              playUiClick();
              onClose();
            }}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5 text-xs">
          {/* Key Input Section */}
          <div className="space-y-2">
            <label className="flex items-center justify-between text-slate-300 font-semibold">
              <span className="flex items-center gap-1.5">
                <Key className="w-4 h-4 text-cyan-400" />
                Chave da OpenAI (OPENAI_API_KEY)
              </span>
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-cyan-400 hover:underline flex items-center gap-1"
              >
                Obter chave <ExternalLink className="w-3 h-3" />
              </a>
            </label>

            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-proj-..."
                className="w-full px-3.5 py-2.5 pr-10 text-xs bg-[#03080d] border border-cyan-900/60 rounded-xl text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400 font-mono tracking-wider"
              />
              <button
                type="button"
                onClick={() => {
                  playUiClick();
                  setShowKey(!showKey);
                }}
                className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300 transition-colors"
                title={showKey ? 'Ocultar chave' : 'Mostrar chave'}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Verification Status Feedback Alert */}
          {verifyStatus.type && (
            <div
              className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs ${
                verifyStatus.type === 'success'
                  ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                  : 'bg-red-950/40 border-red-500/40 text-red-300'
              }`}
            >
              {verifyStatus.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
              )}
              <span className="leading-relaxed">{verifyStatus.message}</span>
            </div>
          )}

          {/* Privacy & Offline Guarantee Box */}
          <HistorySettings />

          <UpdateSettings />

          <div className="p-3.5 rounded-xl bg-[#040e17] border border-cyan-950/80 space-y-2">
            <div className="flex items-center gap-2 text-cyan-300 font-bold">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Privacidade & Armazenamento Local Seguro</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Sua chave é armazenada com segurança exclusivamente no seu dispositivo local. Ela nunca é enviada a servidores externos de terceiros além da própria OpenAI oficial.
            </p>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>Sem chave? Todo o monitoramento de rede, RTT, Jitter e rotas continua 100% gratuito e offline.</span>
            </div>
          </div>

        </div>

        {/* Modal Footer Controls */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-4 border-t border-cyan-900/40 bg-[#030910]">
          {apiKey ? (
            <button
              onClick={handleRemove}
              type="button"
              className="w-full sm:w-auto px-3.5 py-2 text-xs font-semibold rounded-xl text-red-400 hover:text-red-300 hover:bg-red-950/30 border border-red-900/40 transition-colors flex items-center justify-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remover Chave</span>
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <button
              onClick={handleVerify}
              disabled={isVerifying || !apiKey.trim()}
              type="button"
              className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-cyan-950 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-700/40 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isVerifying ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{isVerifying ? 'Testando...' : 'Testar Conexão'}</span>
            </button>

            <button
              onClick={handleSave}
              disabled={savedSuccess}
              type="button"
              className="px-4 py-2 text-xs font-bold rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-black shadow-lg shadow-cyan-500/20 transition-all flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{savedSuccess ? 'Salvo!' : 'Salvar'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
