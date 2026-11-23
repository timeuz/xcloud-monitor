import React, { useMemo, useState } from 'react';

export interface ChartPoint {
  t: number; // unix seconds
  y: number | null;
  /** optional upper value (p95) drawn as a dashed line */
  hi?: number | null;
}

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  points: ChartPoint[];
}

export interface Shade {
  from: number;
  to: number;
  color: string;
  label: string;
}

export interface Mark {
  t: number;
  color: string;
  label: string;
}

interface Props {
  series: ChartSeries[];
  from: number;
  to: number;
  bucketSecs: number;
  unit?: string;
  height?: number;
  kind?: 'line' | 'bars';
  shades?: Shade[];
  marks?: Mark[];
  ariaLabel: string;
}

const W = 860;
const ML = 46;
const MR = 12;
const MT = 10;
const MB = 24;

export function niceCeil(v: number): number {
  if (!isFinite(v) || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Splits points into drawable runs: breaks on missing values and on gaps (app was closed). */
export function splitRuns(points: ChartPoint[], maxGapSecs: number): ChartPoint[][] {
  const runs: ChartPoint[][] = [];
  let cur: ChartPoint[] = [];
  let last: number | null = null;
  for (const p of points) {
    const gap = last !== null && p.t - last > maxGapSecs;
    if (p.y === null || gap) {
      if (cur.length) runs.push(cur);
      cur = [];
    }
    if (p.y !== null) cur.push(p);
    last = p.t;
  }
  if (cur.length) runs.push(cur);
  return runs;
}

function fmtTime(t: number, spanSecs: number): string {
  const d = new Date(t * 1000);
  if (spanSecs <= 36 * 3600) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

export const TimeSeriesChart: React.FC<Props> = ({
  series,
  from,
  to,
  bucketSecs,
  unit = 'ms',
  height = 240,
  kind = 'line',
  shades = [],
  marks = [],
  ariaLabel,
}) => {
  const [hoverT, setHoverT] = useState<number | null>(null);
  const span = Math.max(1, to - from);
  const plotW = W - ML - MR;
  const plotH = height - MT - MB;

  const yMax = useMemo(() => {
    let m = 0;
    for (const s of series) {
      for (const p of s.points) {
        if (p.y !== null) m = Math.max(m, p.y);
        if (p.hi != null) m = Math.max(m, p.hi);
      }
    }
    return niceCeil(m * 1.05);
  }, [series]);

  const x = (t: number) => ML + ((t - from) / span) * plotW;
  const y = (v: number) => MT + plotH - (v / yMax) * plotH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * span);

  const hover = useMemo(() => {
    if (hoverT === null) return null;
    return series.map((s) => {
      let best: ChartPoint | null = null;
      for (const p of s.points) {
        if (Math.abs(p.t - hoverT) <= bucketSecs * 1.5 && (!best || Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT))) {
          best = p;
        }
      }
      return { s, p: best };
    });
  }, [hoverT, series, bucketSecs]);

  const empty = series.every((s) => s.points.every((p) => p.y === null));
  const barW = Math.max(1.5, (bucketSecs / span) * plotW * 0.8);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full h-auto select-none"
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setHoverT(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const svgX = ((e.clientX - rect.left) / rect.width) * W;
          const t = from + ((svgX - ML) / plotW) * span;
          setHoverT(t >= from && t <= to ? t : null);
        }}
      >
        {/* grid + y axis */}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={ML} x2={W - MR} y1={y(v)} y2={y(v)} stroke="#0e2a3a" strokeWidth={1} />
            <text x={ML - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="#64748b" fontFamily="monospace">
              {v >= 10 ? Math.round(v) : v.toFixed(1)}
            </text>
          </g>
        ))}
        <text x={4} y={MT + 8} fontSize={10} fill="#64748b" fontFamily="monospace">
          {unit}
        </text>
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={height - 6} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
            {fmtTime(t, span)}
          </text>
        ))}

        {/* shaded intervals (degradation episodes) */}
        {shades.map((sh, i) => {
          const x1 = Math.max(ML, x(Math.max(from, sh.from)));
          const x2 = Math.min(W - MR, x(Math.min(to, sh.to)));
          if (x2 <= ML || x1 >= W - MR) return null;
          return (
            <rect key={i} x={x1} y={MT} width={Math.max(2, x2 - x1)} height={plotH} fill={sh.color} opacity={0.18}>
              <title>{sh.label}</title>
            </rect>
          );
        })}

        {/* data */}
        {kind === 'line' &&
          series.map((s) => {
            const runs = splitRuns(s.points, bucketSecs * 2.5);
            return (
              <g key={s.id}>
                {runs.map((run, i) => (
                  <React.Fragment key={i}>
                    {run.length === 1 ? (
                      <circle cx={x(run[0].t)} cy={y(run[0].y as number)} r={2} fill={s.color} />
                    ) : (
                      <polyline
                        fill="none"
                        stroke={s.color}
                        strokeWidth={1.6}
                        strokeLinejoin="round"
                        points={run.map((p) => `${x(p.t).toFixed(1)},${y(p.y as number).toFixed(1)}`).join(' ')}
                      />
                    )}
                    {run.some((p) => p.hi != null) && run.length > 1 && (
                      <polyline
                        fill="none"
                        stroke={s.color}
                        strokeWidth={1}
                        strokeDasharray="3 3"
                        opacity={0.55}
                        points={run
                          .filter((p) => p.hi != null)
                          .map((p) => `${x(p.t).toFixed(1)},${y(p.hi as number).toFixed(1)}`)
                          .join(' ')}
                      />
                    )}
                  </React.Fragment>
                ))}
              </g>
            );
          })}

        {kind === 'bars' &&
          series.map((s) =>
            s.points.map(
              (p, i) =>
                p.y !== null && (
                  <rect
                    key={`${s.id}-${i}`}
                    x={x(p.t) - barW / 2}
                    y={y(p.y)}
                    width={barW}
                    height={Math.max(0, MT + plotH - y(p.y))}
                    fill={s.color}
                    opacity={0.85}
                  />
                )
            )
          )}

        {/* event marks */}
        {marks.map((m, i) =>
          m.t >= from && m.t <= to ? (
            <g key={i}>
              <line x1={x(m.t)} x2={x(m.t)} y1={MT} y2={MT + plotH} stroke={m.color} strokeWidth={1} strokeDasharray="4 3" />
              <polygon points={`${x(m.t) - 4},${MT} ${x(m.t) + 4},${MT} ${x(m.t)},${MT + 7}`} fill={m.color}>
                <title>{m.label}</title>
              </polygon>
            </g>
          ) : null
        )}

        {hoverT !== null && <line x1={x(hoverT)} x2={x(hoverT)} y1={MT} y2={MT + plotH} stroke="#94a3b8" strokeWidth={1} />}

        {empty && (
          <text x={W / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="#64748b" fontFamily="monospace">
            Sem dados neste período
          </text>
        )}
      </svg>

      {/* legend + hover readout */}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-slate-400 min-h-[18px]">
        {series.map((s) => {
          const h = hover?.find((x2) => x2.s.id === s.id)?.p;
          return (
            <span key={s.id} className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-0.5 rounded" style={{ background: s.color }} />
              <span>{s.label}</span>
              {hover && (
                <b className="text-slate-200 tabular-nums">
                  {h && h.y !== null ? `${h.y.toFixed(h.y >= 10 ? 0 : 1)} ${unit}` : '—'}
                </b>
              )}
            </span>
          );
        })}
        {hoverT !== null && <span className="ml-auto text-slate-500">{fmtTime(hoverT, span)}</span>}
      </div>
    </div>
  );
};
