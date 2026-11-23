import React, { useState } from 'react';
import { HourProfile } from '../../services/nativeBridge';
import { niceCeil } from './TimeSeriesChart';

interface Props {
  profile: HourProfile[];
  /** local hours flagged as peak by the analysis */
  peakHours: number[];
  ariaLabel: string;
}

const W = 860;
const H = 200;
const ML = 40;
const MR = 8;
const MT = 10;
const MB = 22;

/** Median latency per local hour of the day; p95 as a tick; peak hours in amber. */
export const HourProfileChart: React.FC<Props> = ({ profile, peakHours, ariaLabel }) => {
  const [hover, setHover] = useState<HourProfile | null>(null);
  const byHour = new Map(profile.map((p) => [p.hour, p]));
  const yMax = niceCeil(Math.max(1, ...profile.map((p) => p.p95 ?? p.p50)) * 1.05);
  const plotW = W - ML - MR;
  const plotH = H - MT - MB;
  const slot = plotW / 24;
  const y = (v: number) => MT + plotH - (v / yMax) * plotH;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={ML} x2={W - MR} y1={y(f * yMax)} y2={y(f * yMax)} stroke="#0e2a3a" />
            <text x={ML - 6} y={y(f * yMax) + 3} textAnchor="end" fontSize={10} fill="#64748b" fontFamily="monospace">
              {Math.round(f * yMax)}
            </text>
          </g>
        ))}
        {Array.from({ length: 24 }, (_, h) => {
          const p = byHour.get(h);
          const cx = ML + h * slot + slot / 2;
          return (
            <g key={h} onMouseEnter={() => p && setHover(p)}>
              {h % 3 === 0 && (
                <text x={cx} y={H - 6} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="monospace">
                  {String(h).padStart(2, '0')}h
                </text>
              )}
              {p && (
                <>
                  <rect
                    x={cx - slot * 0.35}
                    y={y(p.p50)}
                    width={slot * 0.7}
                    height={Math.max(1, MT + plotH - y(p.p50))}
                    fill={peakHours.includes(h) ? '#f59e0b' : '#22d3ee'}
                    opacity={0.85}
                  />
                  {p.p95 != null && <line x1={cx - slot * 0.35} x2={cx + slot * 0.35} y1={y(p.p95)} y2={y(p.p95)} stroke="#e2e8f0" strokeWidth={1.5} />}
                </>
              )}
            </g>
          );
        })}
        {profile.length === 0 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={12} fill="#64748b" fontFamily="monospace">
            Ainda sem dados suficientes por horário
          </text>
        )}
      </svg>
      <div className="mt-1 text-[11px] font-mono text-slate-400 min-h-[18px]">
        {hover ? (
          <span>
            {String(hover.hour).padStart(2, '0')}h · mediana <b className="text-slate-200">{hover.p50.toFixed(1)} ms</b> · p95{' '}
            <b className="text-slate-200">{hover.p95 != null ? hover.p95.toFixed(1) : '—'} ms</b> · perda{' '}
            <b className="text-slate-200">{hover.lossPct.toFixed(1)}%</b> · {hover.days} dia(s) de dados
          </span>
        ) : (
          <span className="text-slate-500">Barra = mediana · traço = p95 · âmbar = horário de pico</span>
        )}
      </div>
    </div>
  );
};
