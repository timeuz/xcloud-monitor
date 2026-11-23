import React, { useCallback, useEffect, useState } from 'react';
import { Database, Download, Trash2, Loader2, FileText } from 'lucide-react';
import {
  DesktopSettings,
  HistoryStats,
  clearHistory,
  exportEvidenceReport,
  exportHistoryCsv,
  fetchDesktopSettings,
  fetchHistoryStats,
  isTauriApp,
  setAutostart,
  setCloseToTray,
  setHistoryEnabled,
} from '../services/nativeBridge';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTs(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString('pt-BR') : '—';
}

/** Privacy controls for the local measurement history: status, on/off, export and wipe. */
export const HistorySettings: React.FC = () => {
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [desktop, setDesktop] = useState<DesktopSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setStats(await fetchHistoryStats());
      setDesktop(await fetchDesktopSettings());
    } catch (err: any) {
      setMessage(err?.message || String(err));
    }
  }, []);

  useEffect(() => {
    if (isTauriApp()) load();
  }, [load]);

  if (!isTauriApp()) return null;

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage('');
    try {
      const out = await action();
      if (typeof out === 'string') setMessage(out);
      await load();
    } catch (err: any) {
      setMessage(`Erro: ${err?.message || err}`);
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-cyan-900/40 bg-[#030910] p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-semibold text-slate-300">
          <Database className="w-3.5 h-3.5 text-cyan-400" />
          Histórico local de medições
        </span>
        {stats && (
          <label className="flex items-center gap-2 cursor-pointer text-slate-300">
            <input
              type="checkbox"
              checked={stats.enabled}
              disabled={busy}
              onChange={(e) => {
                run(() => setHistoryEnabled(e.target.checked));
              }}
            />
            <span>{stats.enabled ? 'Coletando' : 'Pausado'}</span>
          </label>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-400">
        Guarda, só neste computador, a latência dos alvos a cada {stats?.intervalSecs ?? 30}s, as rotas e os
        testes de bufferbloat, para analisar horários e padrões. Nada é enviado para fora.
      </p>

      {stats && (
        <p className="text-[11px] font-mono text-slate-500">
          {stats.sampleCount.toLocaleString('pt-BR')} amostras · {stats.hourlyCount.toLocaleString('pt-BR')} resumos por hora ·{' '}
          {formatBytes(stats.dbBytes)} · de {formatTs(stats.oldestTs)} · amostras brutas mantidas por {stats.rawRetentionDays} dias
        </p>
      )}

      {desktop && (
        <div className="space-y-1.5 pt-1 text-[11px] text-slate-300">
          <label className={`flex items-start gap-2 ${desktop.trayAvailable ? 'cursor-pointer' : 'opacity-60'}`}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={desktop.closeToTray && desktop.trayAvailable}
              disabled={busy || !desktop.trayAvailable}
              onChange={(e) => {
                run(() => setCloseToTray(e.target.checked));
              }}
            />
            <span>
              Continuar coletando na bandeja ao fechar a janela
              {!desktop.trayAvailable && (
                <b className="text-amber-300"> — indisponível: o sistema não ofereceu ícone de bandeja, então fechar a janela encerra o app e a coleta.</b>
              )}
              {desktop.trayAvailable && !desktop.closeToTray && (
                <i className="text-slate-500"> (desligado: fechar a janela encerra o app e a coleta)</i>
              )}
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={desktop.autostart}
              disabled={busy}
              onChange={(e) => {
                run(() => setAutostart(e.target.checked));
              }}
            />
            <span>Iniciar com o sistema{desktop.trayAvailable ? ', minimizado na bandeja' : ''}</span>
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          disabled={busy || !stats || stats.sampleCount === 0}
          onClick={() => {
            run(async () => `Relatório salvo em ${await exportEvidenceReport()} (abra no navegador e imprima em PDF)`);
          }}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-black flex items-center gap-1.5 disabled:opacity-50"
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Relatório para o ISP</span>
        </button>
        <button
          type="button"
          disabled={busy || !stats || stats.sampleCount === 0}
          onClick={() => {
            run(async () => `CSV salvo em ${await exportHistoryCsv()}`);
          }}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-950 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-700/40 flex items-center gap-1.5 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          <span>Exportar CSV</span>
        </button>
        <button
          type="button"
          disabled={busy || !stats || stats.sampleCount === 0}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            run(async () => {
              await clearHistory();
              return 'Histórico apagado.';
            });
          }}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-950/60 hover:bg-red-900/50 text-red-300 border border-red-700/40 flex items-center gap-1.5 disabled:opacity-50"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>{confirmClear ? 'Clique de novo para apagar tudo' : 'Apagar histórico'}</span>
        </button>
      </div>

      {message && <p className="text-[11px] font-mono text-cyan-300 break-all">{message}</p>}
    </div>
  );
};
