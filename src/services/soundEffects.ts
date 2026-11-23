/**
 * Web Audio API procedural sound synthesizer.
 * Zero external asset dependencies (100% procedural Web Audio oscillators).
 *
 * Configured so audio sounds ONLY when the "Momento para Jogar" verdict rank changes,
 * with notable, high-impact acoustic profiles (celebratory upgrade chime vs urgent cyber warning).
 */

let audioCtx: AudioContext | null = null;
let soundEnabled = true;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function setSoundEnabled(enabled: boolean) {
  soundEnabled = enabled;
}

export function isSoundEnabled(): boolean {
  return soundEnabled;
}

/**
 * NOTABLE, crystal-clear celebratory chime when "Momento para Jogar" improves (e.g. upgraded to Rank S or A).
 * Multi-layer resonant chime: F5 (698Hz) -> A5 (880Hz) -> C6 (1046Hz) -> F6 (1396Hz) with harmonic shimmer.
 */
export function playVerdictUpgradeSound() {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const notes = [698.46, 880.0, 1046.5, 1396.91];

    notes.forEach((freq, idx) => {
      // Main clear bell oscillator
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const noteStart = now + idx * 0.085;
      const noteDuration = 0.45;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, noteStart);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.01, noteStart + noteDuration);

      gain.gain.setValueAtTime(0.18, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteDuration);

      // Harmonic shimmer layer
      const harmOsc = ctx.createOscillator();
      const harmGain = ctx.createGain();
      harmOsc.type = 'triangle';
      harmOsc.frequency.setValueAtTime(freq * 2, noteStart);

      harmGain.gain.setValueAtTime(0.06, noteStart);
      harmGain.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteDuration * 0.7);

      osc.connect(gain);
      gain.connect(ctx.destination);

      harmOsc.connect(harmGain);
      harmGain.connect(ctx.destination);

      osc.start(noteStart);
      osc.stop(noteStart + noteDuration);

      harmOsc.start(noteStart);
      harmOsc.stop(noteStart + noteDuration * 0.7);
    });
  } catch (e) {
    // Ignore
  }
}

/**
 * NOTABLE, urgent cyber warning alert when "Momento para Jogar" degrades (e.g. Rank dropped to B or F).
 * Heavy dual-frequency saw-pulse with urgent bass drop (720Hz -> 240Hz) and distinct sub-bass alert.
 */
export function playVerdictDegradeSound() {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // 2 rapid aggressive cyber alert bursts
    [0, 0.24].forEach((offset) => {
      const burstStart = now + offset;
      const duration = 0.22;

      // Heavy Sawtooth Oscillator for piercing alert tone
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(740, burstStart);
      osc.frequency.exponentialRampToValueAtTime(260, burstStart + duration);

      gain.gain.setValueAtTime(0.24, burstStart);
      gain.gain.exponentialRampToValueAtTime(0.001, burstStart + duration);

      // Sub-bass impact oscillator
      const subOsc = ctx.createOscillator();
      const subGain = ctx.createGain();
      subOsc.type = 'triangle';
      subOsc.frequency.setValueAtTime(140, burstStart);
      subOsc.frequency.exponentialRampToValueAtTime(60, burstStart + duration);

      subGain.gain.setValueAtTime(0.28, burstStart);
      subGain.gain.exponentialRampToValueAtTime(0.001, burstStart + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      subOsc.connect(subGain);
      subGain.connect(ctx.destination);

      osc.start(burstStart);
      osc.stop(burstStart + duration);

      subOsc.start(burstStart);
      subOsc.stop(burstStart + duration);
    });
  } catch (e) {
    // Ignore
  }
}

/**
 * Cute, recognizable robotic Wall-E / R2-D2 / BB-8 modulated chirps when the robot mascot speaks
 */
export function playMascotRobotChirp() {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const chirps = [
      { f1: 1100, f2: 1750, dur: 0.05 },
      { f1: 1450, f2: 1250, dur: 0.045 },
      { f1: 1600, f2: 2150, dur: 0.06 },
    ];

    let start = now;
    chirps.forEach((c) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(c.f1, start);
      osc.frequency.exponentialRampToValueAtTime(c.f2, start + c.dur);

      gain.gain.setValueAtTime(0.12, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + c.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + c.dur);

      start += c.dur + 0.02;
    });
  } catch (e) {
    // Ignore
  }
}

/**
 * Subtle interface interaction click
 */
export function playUiClick() {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(950, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.025);

    gain.gain.setValueAtTime(0.04, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.025);
  } catch (e) {
    // Ignore
  }
}

export function playSuccessChime() {
  playVerdictUpgradeSound();
}

export function playWarningAlarm() {
  playVerdictDegradeSound();
}
