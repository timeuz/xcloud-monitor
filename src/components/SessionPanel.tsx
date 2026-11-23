import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Server } from 'lucide-react';
import { SessionRun, fetchSessionRuns, measureSessionPeer } from '../services/nativeBridge';

const fmt = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)} ms`);
const when = (ts: number) => new Date(ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Difference between the game server and the xCloud entry point, in words. */
export function entryDelta(run: Pick<SessionRun, 'rttP50' | 'entryRtt'>): { text: string; cls: string } {
  if (run.rttP50 == null || run.entryRtt == null) return { text: '—', cls: 'text-slate-500' };
  const d = run.rttP50 - run.entryRtt;
  const text = `${d >= 0 ? '+' : ''}${d.toFixed(1)} ms`;
  if (d >= 30) return { text: `${text} (partida alocada longe)`, cls: 'text-red-300' };
  if (d >= 10) return { text: `${text} (um pouco mais longe)`, cls: 'text-amber-300' };
  return { text, cls: 'text-emerald-300' };
}

const SCRIPT_URL = 'https://raw.githubusercontent.com/timeuz/xcloud-monitor/main/scripts/find-session-peer.sh';

/** Measures the game's own media server; the user supplies its address (it changes every match). */
export const SessionPanel: React.FC = () => {
  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [peer, setPeer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRuns(await fetchSessionRuns(10));
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg space-y-3">
      <div>
        <h4 className="text-xs font-bold font-mono text-slate-300 uppercase flex items-center gap-1.5">
          <Server className="w-3.5 h-3.5 text-cyan-400" />
          Servidor real da sessão de jogo
        </h4>
        <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
          O servidor que serve a sua partida muda a cada sessão e um aplicativo comum não consegue vê-lo. Com o jogo rodando, descubra o endereço com o
          script abaixo (precisa de <code>sudo</code> para capturar pacotes por alguns segundos; nada é gravado nem enviado) e cole aqui. O app mede ping e rota até
          ele e compara com o servidor de entrada do xCloud.
        </p>
        <details className="mt-1 text-[11px] text-slate-400">
          <summary className="cursor-pointer text-cyan-300">Como descobrir o endereço (Linux/macOS)</summary>
          <pre className="mt-1 p-2 rounded bg-[#030a12] border border-cyan-950 overflow-x-auto whitespace-pre-wrap">{`curl -fsSLO ${SCRIPT_URL}
# leia o script antes de executar
sudo bash find-session-peer.sh`}</pre>
          <p className="mt-1">No Windows, use o Wireshark e procure o fluxo UDP com mais bytes para um endereço público.</p>
        </details>
      </div>

      <form
        className="flex flex-col sm:flex-row gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!peer.trim() || busy) return;
          setBusy(true);
          setError('');
          try {
            await measureSessionPeer(peer.trim(), note.trim() || undefined);
            setPeer('');
            setNote('');
            await load();
          } catch (err: any) {
            setError(err?.message || String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          value={peer}
          onChange={(e) => setPeer(e.target.value)}
          placeholder="IP do servidor (ex.: 13.104.105.250:1069)"
          className="flex-1 px-3 py-1.5 rounded-lg bg-[#030a12] border border-cyan-900/60 text-xs font-mono text-slate-200 placeholder:text-slate-600"
          aria-label="Endereço do servidor da sessão"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Nota (opcional)"
          maxLength={80}
          className="sm:w-48 px-3 py-1.5 rounded-lg bg-[#030a12] border border-cyan-900/60 text-xs font-mono text-slate-200 placeholder:text-slate-600"
          aria-label="Nota"
        />
        <button
          type="submit"
          disabled={busy || !peer.trim()}
          className="px-3 py-1.5 text-xs font-semibold font-mono rounded-lg bg-cyan-950 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-700/40 flex items-center justify-center gap-1.5 disabled:opacity-50 shrink-0"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <span>{busy ? 'Medindo (até 1 min)...' : 'Medir servidor da sessão'}</span>
        </button>
      </form>
      {error && <p className="text-[11px] font-mono text-red-300">{error}</p>}

      {runs.length === 0 ? (
        <p className="text-xs font-mono text-slate-500">Nenhum servidor de sessão medido ainda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono text-slate-300">
            <thead>
              <tr className="text-left text-slate-500 border-b border-cyan-950">
                <th className="py-1 pr-3">Quando</th>
                <th className="pr-3">Servidor</th>
                <th className="pr-3">RTT mediano</th>
                <th className="pr-3">p95</th>
                <th className="pr-3">Perda</th>
                <th className="pr-3">Contra a entrada do xCloud</th>
                <th>Rota</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const d = entryDelta(r);
                return (
                  <tr key={r.ts} className="border-b border-cyan-950/50">
                    <td className="py-1.5 pr-3">{when(r.ts)}</td>
                    <td className="pr-3">
                      {r.peerIp}
                      {r.note ? <span className="text-slate-500"> · {r.note}</span> : null}
                    </td>
                    <td className="pr-3">{r.icmpBlocked ? <span className="text-amber-300">não responde a ICMP</span> : fmt(r.rttP50)}</td>
                    <td className="pr-3">{fmt(r.rttP95)}</td>
                    <td className="pr-3">{r.icmpBlocked ? '—' : `${r.lossPct.toFixed(1)}%`}</td>
                    <td className={`pr-3 ${d.cls}`}>{d.text}</td>
                    <td>
                      {r.hopCount === 0 ? 'não medida' : `${r.hopCount} saltos`}
                      {r.hairpin ? <span className="text-red-300"> · desvio p/ EUA</span> : null}
                      {r.largestJump ? <span className="text-slate-500"> · +{r.largestJump.deltaMs.toFixed(0)} ms entre {r.largestJump.fromTtl} e {r.largestJump.toTtl}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
