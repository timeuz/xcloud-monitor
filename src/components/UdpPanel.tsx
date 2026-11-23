import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { UdpRunRow, UdpTestResponse, fetchUdpRuns, runUdpTest } from '../services/nativeBridge';
import { playUiClick } from '../services/soundEffects';

const fmt = (v: number | null | undefined, unit = 'ms') => (v == null ? '—' : `${v.toFixed(1)} ${unit}`);
const when = (ts: number) => new Date(ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Lossy-UDP verdict in plain words, from loss and the longest burst. */
export function udpVerdict(lossPct: number, maxBurst: number): { text: string; cls: string } {
  if (lossPct === 0) return { text: 'Sem perda', cls: 'text-emerald-300' };
  if (lossPct < 1 && maxBurst <= 2) return { text: 'Perda mínima', cls: 'text-emerald-300' };
  if (lossPct < 3 && maxBurst <= 5) return { text: 'Perda leve', cls: 'text-amber-300' };
  return { text: 'Perda perceptível no vídeo', cls: 'text-red-300' };
}

export const UdpPanel: React.FC = () => {
  const [runs, setRuns] = useState<UdpRunRow[]>([]);
  const [last, setLast] = useState<UdpTestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRuns(await fetchUdpRuns(30));
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 6000);
    return () => clearTimeout(t);
  }, [confirming]);

  const shown = last
    ? last.results.map((r) => ({ key: r.id, label: r.label, sent: r.sent, received: r.received, lossPct: r.lossPct, burst: r.maxBurstLoss, p50: r.rttP50, p95: r.rttP95, jitter: r.jitter, error: r.error, ts: last.measuredAt }))
    : runs.slice(0, 3).map((r) => ({ key: `${r.ts}-${r.targetId}`, label: r.label, sent: r.sent, received: r.received, lossPct: r.lossPct, burst: r.maxBurst, p50: r.rttP50, p95: r.rttP95, jitter: r.jitter, error: null as string | null, ts: r.ts }));

  return (
    <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-bold font-mono text-slate-300 uppercase flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            Teste UDP (o protocolo do jogo)
          </h4>
          <p className="text-[11px] text-slate-500 mt-0.5">
            50 pacotes por segundo durante 10 s para servidores STUN da Cloudflare, Google e Microsoft. Mede RTT, perda e a maior sequência de pacotes perdidos
            em UDP; não mede banda.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          title="Envia cerca de 1.500 pacotes de 20 bytes (30 KB) a servidores públicos. Leva ~35 s."
          onClick={async () => {
            playUiClick();
            if (!confirming) {
              setConfirming(true);
              return;
            }
            setConfirming(false);
            setBusy(true);
            setError('');
            try {
              setLast(await runUdpTest());
              await load();
            } catch (err: any) {
              setError(err?.message || String(err));
            } finally {
              setBusy(false);
            }
          }}
          className="px-3 py-1.5 text-xs font-semibold font-mono rounded-lg bg-cyan-950 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-700/40 flex items-center gap-1.5 disabled:opacity-60 shrink-0"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
          <span>{busy ? 'Medindo ~35 s...' : confirming ? 'Confirmar: ~30 KB para 3 servidores' : 'Rodar teste UDP'}</span>
        </button>
      </div>

      {error && <p className="text-[11px] font-mono text-red-300">{error}</p>}

      {shown.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono text-slate-300">
            <thead>
              <tr className="text-left text-slate-500 border-b border-cyan-950">
                <th className="py-1 pr-3">Servidor</th>
                <th className="pr-3">Recebidos</th>
                <th className="pr-3">Perda</th>
                <th className="pr-3">Maior sequência perdida</th>
                <th className="pr-3">RTT mediano</th>
                <th className="pr-3">p95</th>
                <th className="pr-3">Jitter</th>
                <th>Leitura</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const v = udpVerdict(r.lossPct, r.burst);
                return (
                  <tr key={r.key} className="border-b border-cyan-950/50">
                    <td className="py-1.5 pr-3 font-semibold">{r.label}</td>
                    {r.error ? (
                      <td colSpan={7} className="text-red-300">
                        {r.error}
                      </td>
                    ) : (
                      <>
                        <td className="pr-3">
                          {r.received}/{r.sent}
                        </td>
                        <td className="pr-3">{r.lossPct.toFixed(1)}%</td>
                        <td className="pr-3">{r.burst}</td>
                        <td className="pr-3">{fmt(r.p50)}</td>
                        <td className="pr-3">{fmt(r.p95)}</td>
                        <td className="pr-3">{fmt(r.jitter)}</td>
                        <td className={v.cls}>{v.text}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-slate-500">
            {last ? 'Resultado do teste que acabou de rodar.' : `Último teste: ${when(shown[0].ts)}.`} {runs.length > 0 && `${runs.length} resultado(s) gravados no histórico.`}
          </p>
        </div>
      ) : (
        <p className="text-xs font-mono text-slate-500">Nenhum teste UDP ainda.</p>
      )}
    </div>
  );
};
