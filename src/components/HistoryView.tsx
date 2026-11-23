import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, FileText, Loader2, RefreshCw } from 'lucide-react';
import {
  AnalysisReport,
  DegradationEpisode,
  HistorySeriesResponse,
  exportEvidenceReport,
  fetchHistoryAnalysis,
  fetchHistorySeries,
  isTauriApp,
} from '../services/nativeBridge';
import { playUiClick } from '../services/soundEffects';
import { ChartSeries, Mark, Shade, TimeSeriesChart } from './charts/TimeSeriesChart';
import { HourProfileChart } from './charts/HourProfileChart';

const WINDOWS = [
  { hours: 6, label: '6 h' },
  { hours: 24, label: '24 h' },
  { hours: 168, label: '7 dias' },
  { hours: 336, label: '14 dias' },
];

const ROLE_COLOR: Record<string, string> = {
  local_gateway: '#34d399',
  isp_hop1: '#fbbf24',
  xcloud: '#22d3ee',
};

const CAUSE_LABEL: Record<DegradationEpisode['cause'], string> = {
  local: 'Rede local (o roteador também degradou)',
  'isp-access': 'Acesso da operadora (1º salto)',
  'isp-core': 'Núcleo da operadora',
  'beyond-local': 'Fora da rede local',
  'microsoft-path': 'Caminho até a Microsoft',
  unknown: 'Não determinada',
};

const KIND_LABEL: Record<DegradationEpisode['kind'], string> = {
  latencia: 'Latência alta',
  perda: 'Perda de pacotes',
  mista: 'Latência e perda',
};

const CONFIDENCE_LABEL: Record<AnalysisReport['confidence'], { text: string; cls: string }> = {
  insufficient: { text: 'Dados insuficientes', cls: 'border-slate-600/60 text-slate-300 bg-slate-900' },
  low: { text: 'Confiança baixa', cls: 'border-amber-500/50 text-amber-300 bg-amber-950/40' },
  medium: { text: 'Confiança média', cls: 'border-cyan-500/50 text-cyan-300 bg-cyan-950/40' },
  high: { text: 'Confiança alta', cls: 'border-emerald-500/50 text-emerald-300 bg-emerald-950/40' },
};

const SEVERITY_CLS: Record<string, string> = {
  critical: 'border-red-500/60 bg-red-950/30 text-red-200',
  warn: 'border-amber-500/50 bg-amber-950/20 text-amber-100',
  info: 'border-cyan-800/60 bg-cyan-950/20 text-slate-200',
};

const fmtMs = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)} ms`);
const fmtDateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export const HistoryView: React.FC = () => {
  const [hours, setHours] = useState(24);
  const [series, setSeries] = useState<HistorySeriesResponse | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [group, setGroup] = useState<'weekday' | 'weekend'>('weekday');
  const [exportMsg, setExportMsg] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([fetchHistorySeries(hours), fetchHistoryAnalysis(14)]);
      setSeries(s);
      setReport(r);
      setError('');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    if (!isTauriApp()) return;
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const latencySeries: ChartSeries[] = useMemo(
    () =>
      (series?.series ?? []).map((s) => ({
        id: s.id,
        label: s.label,
        color: ROLE_COLOR[s.role] ?? '#94a3b8',
        points: s.points.map((p) => ({ t: p.ts, y: p.p50, hi: s.role === 'xcloud' ? p.p95 : null })),
      })),
    [series]
  );

  const lossSeries: ChartSeries[] = useMemo(() => {
    const x = series?.series.find((s) => s.role === 'xcloud');
    return x ? [{ id: 'loss', label: 'Perda até o xCloud', color: '#f87171', points: x.points.map((p) => ({ t: p.ts, y: p.lossPct })) }] : [];
  }, [series]);

  const shades: Shade[] = useMemo(
    () =>
      (report?.episodes ?? []).map((e) => ({
        from: e.start,
        to: e.end,
        color: e.cause === 'local' ? '#f59e0b' : '#ef4444',
        label: `${KIND_LABEL[e.kind]} · ${e.durationMin} min · ${CAUSE_LABEL[e.cause]}`,
      })),
    [report]
  );

  const marks: Mark[] = useMemo(() => {
    const m: Mark[] = [];
    for (const r of series?.routes ?? []) {
      if (r.hairpin) m.push({ t: r.ts, color: '#f87171', label: 'Rota desviada para os EUA' });
    }
    for (const b of series?.bloats ?? []) {
      m.push({ t: b.ts, color: '#c084fc', label: `Teste de bufferbloat: nota ${b.grade ?? '—'} (+${b.delta.toFixed(0)} ms)` });
    }
    return m;
  }, [series]);

  if (!isTauriApp()) {
    return (
      <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-6 text-sm font-mono text-slate-400">
        O histórico local está disponível no aplicativo desktop.
      </div>
    );
  }

  const peakHours = (report?.peakHours ?? []).filter((p) => p.group === group).map((p) => p.hour);
  const profile = group === 'weekday' ? report?.profileWeekday ?? [] : report?.profileWeekend ?? [];
  const hasData = (series?.series.length ?? 0) > 0;
  const conf = report ? CONFIDENCE_LABEL[report.confidence] : null;
  const windowEpisodes = (report?.episodes ?? []).filter((e) => series && e.end >= series.from);

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold font-mono tracking-wide text-slate-100 uppercase">
              HISTÓRICO E ANÁLISE // MEDIÇÕES GRAVADAS NESTE COMPUTADOR
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            {conf && report && (
              <span className={`px-2 py-1 rounded border ${conf.cls}`} title="Quanto histórico existe para as conclusões">
                {conf.text} · {report.coverageHours} h de dados
              </span>
            )}
            <div className="flex items-center gap-1 bg-[#030a12] border border-cyan-900/60 rounded-lg p-1">
              {WINDOWS.map((w) => (
                <button
                  key={w.hours}
                  type="button"
                  onClick={() => {
                    playUiClick();
                    setHours(w.hours);
                  }}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    hours === w.hours ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                playUiClick();
                load();
              }}
              className="p-1.5 rounded-lg bg-cyan-950/40 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-800/40"
              title="Atualizar"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={async () => {
                playUiClick();
                setExporting(true);
                setExportMsg('');
                try {
                  setExportMsg(`Relatório salvo em ${await exportEvidenceReport()}`);
                } catch (err: any) {
                  setExportMsg(`Erro: ${err?.message || err}`);
                } finally {
                  setExporting(false);
                }
              }}
              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-black font-semibold flex items-center gap-1.5 disabled:opacity-50"
            >
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              <span>Relatório para o ISP</span>
            </button>
          </div>
        </div>
        {exportMsg && <p className="mt-2 text-[11px] font-mono text-cyan-300 break-all">{exportMsg}</p>}
        {error && <p className="mt-2 text-[11px] font-mono text-red-300">Erro ao carregar: {error}</p>}
      </div>

      {!hasData && !error && (
        <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-6 text-sm font-mono text-slate-400 space-y-1">
          <p>Ainda não há medições neste período.</p>
          <p className="text-xs text-slate-500">
            O app mede a cada 30 s em segundo plano enquanto estiver aberto. Em Configurações você pode conferir se a coleta está ligada.
          </p>
        </div>
      )}

      {/* insights */}
      {report && report.insights.length > 0 && (
        <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg space-y-2">
          <h4 className="text-xs font-bold font-mono text-slate-300 uppercase">Achados</h4>
          {[...report.insights]
            .sort((a, b) => ['critical', 'warn', 'info'].indexOf(a.severity) - ['critical', 'warn', 'info'].indexOf(b.severity))
            .map((i) => (
              <div key={i.id} className={`rounded-lg border-l-4 border p-3 text-xs ${SEVERITY_CLS[i.severity] ?? SEVERITY_CLS.info}`}>
                <div className="font-bold">{i.title}</div>
                <div className="mt-0.5 opacity-90">{i.detail}</div>
                {i.suggestion && <div className="mt-1 italic opacity-80">{i.suggestion}</div>}
              </div>
            ))}
        </div>
      )}

      {hasData && series && (
        <>
          <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg">
            <h4 className="text-xs font-bold font-mono text-slate-300 uppercase mb-1">Latência no tempo (mediana por período)</h4>
            <p className="text-[11px] text-slate-500 mb-2">
              Linha tracejada = p95 do servidor xCloud. Faixas vermelhas = episódios de degradação (âmbar = começaram na rede local). Triângulo vermelho = rota
              desviada; roxo = teste de bufferbloat.
            </p>
            <TimeSeriesChart
              series={latencySeries}
              from={series.from}
              to={series.to}
              bucketSecs={series.bucketSecs}
              shades={shades}
              marks={marks}
              ariaLabel="Latência ao longo do tempo: roteador, primeiro salto do ISP e servidor xCloud"
            />
          </div>

          <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg">
            <h4 className="text-xs font-bold font-mono text-slate-300 uppercase mb-2">Perda de pacotes até o xCloud (%)</h4>
            <TimeSeriesChart
              series={lossSeries}
              from={series.from}
              to={series.to}
              bucketSecs={series.bucketSecs}
              unit="%"
              height={150}
              kind="bars"
              ariaLabel="Perda de pacotes ao longo do tempo"
            />
          </div>
        </>
      )}

      {report && (
        <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-bold font-mono text-slate-300 uppercase">Latência por hora do dia (últimos 14 dias, hora local)</h4>
            <div className="flex items-center gap-1 bg-[#030a12] border border-cyan-900/60 rounded-lg p-1 text-xs font-mono">
              {(['weekday', 'weekend'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => {
                    playUiClick();
                    setGroup(g);
                  }}
                  className={`px-2.5 py-1 rounded ${group === g ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold' : 'text-slate-400'}`}
                >
                  {g === 'weekday' ? 'Dias úteis' : 'Fins de semana'}
                </button>
              ))}
            </div>
          </div>
          <HourProfileChart profile={profile} peakHours={peakHours} ariaLabel="Latência mediana por hora do dia" />
        </div>
      )}

      {report && report.pathComparison.length > 0 && (
        <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg overflow-x-auto">
          <h4 className="text-xs font-bold font-mono text-slate-300 uppercase mb-2">Roteador × operadora × xCloud</h4>
          <table className="w-full text-xs font-mono text-slate-300">
            <thead>
              <tr className="text-left text-slate-500 border-b border-cyan-950">
                <th className="py-1 pr-3">Ponto</th>
                <th className="pr-3">Mediana</th>
                <th className="pr-3">p95</th>
                <th className="pr-3">Jitter</th>
                <th className="pr-3">Perda</th>
                <th>Durante os episódios ruins</th>
              </tr>
            </thead>
            <tbody>
              {report.pathComparison.map((s) => (
                <tr key={s.id} className="border-b border-cyan-950/50">
                  <td className="py-1.5 pr-3 font-semibold" style={{ color: ROLE_COLOR[s.role] }}>{s.label}</td>
                  <td className="pr-3">{fmtMs(s.p50)}</td>
                  <td className="pr-3">{fmtMs(s.p95)}</td>
                  <td className="pr-3">{fmtMs(s.jitter)}</td>
                  <td className="pr-3">{s.lossPct.toFixed(2)}%</td>
                  <td>
                    {s.duringEpisodes
                      ? `${fmtMs(s.duringEpisodes.p50)} · p95 ${fmtMs(s.duringEpisodes.p95)} · perda ${s.duringEpisodes.lossPct.toFixed(1)}%`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && (
        <div className="rounded-xl border border-cyan-900/40 bg-[#06111a] p-4 shadow-lg overflow-x-auto">
          <h4 className="text-xs font-bold font-mono text-slate-300 uppercase mb-2">
            Episódios de degradação ({windowEpisodes.length} no período, {report.episodes.length} em 14 dias)
          </h4>
          {windowEpisodes.length === 0 ? (
            <p className="text-xs font-mono text-slate-500">Nenhum episódio de 3 minutos ou mais neste período.</p>
          ) : (
            <table className="w-full text-xs font-mono text-slate-300">
              <thead>
                <tr className="text-left text-slate-500 border-b border-cyan-950">
                  <th className="py-1 pr-3">Início</th>
                  <th className="pr-3">Duração</th>
                  <th className="pr-3">Tipo</th>
                  <th className="pr-3">Pico</th>
                  <th className="pr-3">Perda</th>
                  <th>Onde começou</th>
                </tr>
              </thead>
              <tbody>
                {[...windowEpisodes].reverse().map((e) => (
                  <tr key={e.start} className="border-b border-cyan-950/50">
                    <td className="py-1.5 pr-3">{fmtDateTime(e.start)}</td>
                    <td className="pr-3">{e.durationMin} min</td>
                    <td className="pr-3">{KIND_LABEL[e.kind]}</td>
                    <td className="pr-3">{fmtMs(e.peakRtt)}</td>
                    <td className="pr-3">{e.lossPct.toFixed(1)}%</td>
                    <td>
                      {CAUSE_LABEL[e.cause]}
                      {e.routeHairpin ? ' · rota desviada p/ EUA' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};
