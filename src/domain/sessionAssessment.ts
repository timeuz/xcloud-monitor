import type { SessionRun } from '../services/nativeBridge';

export type Level = 'good' | 'warn' | 'bad' | 'unknown';

export interface Check {
  key: 'rtt' | 'jitter' | 'loss' | 'entry' | 'route';
  label: string;
  value: string;
  level: Level;
  /** what the number means for the game, in one short sentence */
  hint: string;
}

export interface SessionAssessment {
  level: Level;
  headline: string;
  checks: Check[];
}

const worst = (levels: Level[]): Level => {
  if (levels.includes('bad')) return 'bad';
  if (levels.includes('warn')) return 'warn';
  if (levels.includes('good')) return 'good';
  return 'unknown';
};

/**
 * Plain-language reading of one game-server measurement. The limits follow the app's verdict
 * (RTT < 45 ms good, >= 65 ms critical; jitter > 7 ms noticeable, > 15 ms critical).
 * Loss is judged leniently because routers de-prioritise ICMP: one lost ping out of 20 is already 5%, so warn below 10%.
 */
export function assessSession(run: SessionRun): SessionAssessment {
  const checks: Check[] = [];

  if (run.icmpBlocked || run.rttP50 == null) {
    checks.push({ key: 'rtt', label: 'Latência', value: 'sem resposta', level: 'unknown', hint: 'O servidor não responde a ping; só a rota foi medida.' });
  } else {
    const v = run.rttP50;
    checks.push({
      key: 'rtt',
      label: 'Latência (mediana)',
      value: `${v.toFixed(1)} ms`,
      level: v < 45 ? 'good' : v < 65 ? 'warn' : 'bad',
      hint: v < 45 ? 'Boa para qualquer jogo.' : v < 65 ? 'Jogável; jogos de ação podem ter atraso perceptível.' : 'Alta: atraso nos comandos.',
    });
    if (run.jitter != null) {
      const j = run.jitter;
      checks.push({
        key: 'jitter',
        label: 'Jitter (oscilação)',
        value: `${j.toFixed(1)} ms`,
        level: j <= 7 ? 'good' : j <= 15 ? 'warn' : 'bad',
        hint: j <= 7 ? 'Estável.' : j <= 15 ? 'Oscilação perceptível: pequenos engasgos.' : 'Muito instável: travadas frequentes.',
      });
    }
    const loss = run.lossPct;
    checks.push({
      key: 'loss',
      label: 'Perda de pacotes',
      value: `${loss.toFixed(1)}% (${run.received}/${run.sent})`,
      level: loss === 0 ? 'good' : loss < 10 ? 'warn' : 'bad',
      hint: loss === 0 ? 'Nenhum pacote perdido.' : loss < 10 ? 'Perdas pontuais; roteadores costumam atrasar o ping, então pode não afetar o jogo.' : 'Perda alta: imagem congelando e comandos perdidos.',
    });
  }

  if (run.rttP50 != null && run.entryRtt != null) {
    const d = run.rttP50 - run.entryRtt;
    checks.push({
      key: 'entry',
      label: 'Contra a entrada do xCloud',
      value: `${d >= 0 ? '+' : ''}${d.toFixed(1)} ms`,
      level: d < 10 ? 'good' : d < 30 ? 'warn' : 'bad',
      hint: d < 10 ? 'Servidor da partida tão perto quanto a entrada.' : d < 30 ? 'Partida alocada um pouco mais longe.' : 'Partida alocada longe da entrada.',
    });
  }

  if (run.hopCount > 0) {
    checks.push({
      key: 'route',
      label: 'Rota',
      value: run.hairpin ? 'desvio internacional' : `${run.hopCount} saltos`,
      level: run.hairpin ? 'bad' : 'good',
      hint: run.hairpin ? 'Os pacotes saem do Brasil antes de voltar: problema de roteamento da operadora.' : 'Sem desvio para fora do Brasil.',
    });
  }

  const level = worst(checks.map((c) => c.level));
  const headline =
    level === 'good' ? 'Conexão com o servidor do jogo: boa'
    : level === 'warn' ? 'Conexão com o servidor do jogo: atenção'
    : level === 'bad' ? 'Conexão com o servidor do jogo: ruim'
    : 'Sem dados suficientes para avaliar';
  return { level, headline, checks };
}

export interface HopView {
  ttl: number;
  ip: string;
  name: string;
  location: string;
  rttMs: number | null;
  /** increase over the previous hop that answered; null for the first */
  deltaMs: number | null;
  isLargestJump: boolean;
}

/** Hop list with names and the step added by each hop; the run's largest jump is flagged. */
export function hopViews(run: Pick<SessionRun, 'hops' | 'largestJump'>): HopView[] {
  const out: HopView[] = [];
  let prev: number | null = null;
  for (const h of run.hops ?? []) {
    const answered = h.rttMs > 0 && h.ip && h.ip !== '*';
    const rtt = answered ? h.rttMs : null;
    const delta = rtt != null && prev != null ? rtt - prev : null;
    out.push({
      ttl: h.ttl,
      ip: answered ? h.ip : '*',
      name: h.host && h.host !== h.ip ? h.host : '',
      location: h.location || '',
      rttMs: rtt,
      deltaMs: delta,
      isLargestJump: run.largestJump != null && h.ttl === run.largestJump.toTtl,
    });
    if (rtt != null) prev = rtt;
  }
  return out;
}

export const levelClass: Record<Level, { text: string; badge: string; dot: string }> = {
  good: { text: 'text-emerald-300', badge: 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300', dot: 'bg-emerald-400' },
  warn: { text: 'text-amber-300', badge: 'bg-amber-950/60 border-amber-500/50 text-amber-300', dot: 'bg-amber-400' },
  bad: { text: 'text-red-300', badge: 'bg-red-950/60 border-red-500/50 text-red-300', dot: 'bg-red-400' },
  unknown: { text: 'text-slate-400', badge: 'bg-slate-900 border-slate-600 text-slate-300', dot: 'bg-slate-500' },
};
