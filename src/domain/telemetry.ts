/** Pure telemetry rules extracted from the dashboard so they can be tested as the real code. */

/** Exponential smoothing of the RTT: damps single-sample spikes (70% history, 30% new sample). */
export function smoothRtt(previousSmoothed: number, liveRtt: number): number {
  return Math.round((previousSmoothed * 0.7 + liveRtt * 0.3) * 10) / 10;
}

export interface HairpinState {
  confirmed: boolean;
  /** consecutive cycles that look like an international detour */
  hairpinCount: number;
  /** consecutive cycles that look clearly domestic */
  normalCount: number;
}

export interface HairpinSample {
  liveRtt: number;
  smoothedRtt: number;
  /** RTT to the Brazilian edge (IX.br SP / Equinix); null = did not answer */
  spEdgeRtt: number | null;
  /** RTT to the Miami reference; null = did not answer */
  usMiamiRtt: number | null;
}

const CONFIRM_AFTER = 4;
const CLEAR_AFTER = 3;

/**
 * Hysteresis for the latency-based hairpin heuristic. A detour needs a high RTT, a high Brazilian-edge RTT
 * *and* a RTT close to the Miami reference, sustained for 4 cycles; it clears after 3 clearly domestic cycles.
 * A missing edge/Miami reading never counts as evidence of a detour.
 * (The traceroute evidence is separate and forces the state directly.)
 */
export function nextHairpinState(state: HairpinState, s: HairpinSample): HairpinState {
  const candidate =
    s.liveRtt >= 118 &&
    s.smoothedRtt >= 118 &&
    s.spEdgeRtt != null &&
    s.spEdgeRtt >= 85 &&
    s.usMiamiRtt != null &&
    Math.abs(s.liveRtt - s.usMiamiRtt) <= 40;

  if (candidate) {
    const hairpinCount = state.hairpinCount + 1;
    return { confirmed: state.confirmed || hairpinCount >= CONFIRM_AFTER, hairpinCount, normalCount: 0 };
  }
  if (s.liveRtt < 95 && s.smoothedRtt < 95) {
    const normalCount = state.normalCount + 1;
    return { confirmed: normalCount >= CLEAR_AFTER ? false : state.confirmed, hairpinCount: 0, normalCount };
  }
  return { confirmed: state.confirmed, hairpinCount: 0, normalCount: 0 };
}

/** State forced by hard evidence (a simulation in dev builds, or a traceroute that found the detour). */
export const FORCED_HAIRPIN: HairpinState = { confirmed: true, hairpinCount: 5, normalCount: 0 };
