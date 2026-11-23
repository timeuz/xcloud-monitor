import assert from 'assert';
import { computeVerdict, rawRankWithHysteresis } from '../src/domain/verdict';
import { FORCED_HAIRPIN, HairpinState, nextHairpinState, smoothRtt } from '../src/domain/telemetry';
import { GamingRank, NetworkMetrics, XCloudServerStatus } from '../src/types/telemetry';

/**
 * Resilient telemetry pipeline: EMA smoothing, hairpin hysteresis, rank deadbands and the latency-first rule.
 * These tests import the real dashboard rules (src/domain), not copies of them.
 */

const metrics = (over: Partial<NetworkMetrics> = {}): NetworkMetrics => ({
  rttMs: 36,
  rttAvgMs: 36,
  jitterMs: 1.5,
  packetLossPct: 0,
  bufferbloatDeltaMs: 4,
  samplesSent: 100,
  samplesLost: 0,
  isWifi24Ghz: false,
  ttlHops: 6,
  decodeTimeMs: 4,
  ...over,
});

const server = (over: Partial<XCloudServerStatus> = {}): XCloudServerStatus => ({
  region: 'brazilsouth',
  regionStatus: 'ONLINE',
  dataCenter: 'sp',
  serverLoadPercentage: 30,
  estimatedWaitMinutes: 0,
  queueRisk: 'NONE',
  queueMessage: '',
  currentHourBRT: '12:00',
  peeringHealth: 'ok',
  ...over,
});

console.log('--- TEST 1: Single Spike Resilience (EMA Smoothing) ---');
const smoothed = smoothRtt(14.0, 125.0);
console.log('Smoothed RTT after 1 spike:', smoothed, 'ms');
assert(smoothed < 50.0, 'Smoothed RTT should damp single-sample spikes');
assert.strictEqual(smoothRtt(40, 40), 40);

console.log('\n--- TEST 2: Local SP Edge Low Latency Prevents False Hairpinning ---');
let st: HairpinState = { confirmed: false, hairpinCount: 0, normalCount: 0 };
for (let i = 0; i < 5; i++) {
  st = nextHairpinState(st, { liveRtt: 120, smoothedRtt: 120, spEdgeRtt: 12.2, usMiamiRtt: 118.5 });
}
assert(st.confirmed === false, 'Low SP edge RTT (12.2ms) must NEVER be flagged as BGP Hairpinning');
console.log('Confirmed: Domestic traffic to SP edge is protected against false hairpinning alarms.');

console.log('\n--- TEST 3: Sustained True Hairpinning Confirmation ---');
st = { confirmed: false, hairpinCount: 0, normalCount: 0 };
for (let i = 0; i < 3; i++) st = nextHairpinState(st, { liveRtt: 135, smoothedRtt: 135, spEdgeRtt: 130, usMiamiRtt: 118.5 });
assert(st.confirmed === false, 'three cycles are not enough');
st = nextHairpinState(st, { liveRtt: 135, smoothedRtt: 135, spEdgeRtt: 130, usMiamiRtt: 118.5 });
assert(st.confirmed === true, 'Sustained international latency to both edge and Azure must confirm hairpinning');
console.log('Confirmed: True hairpinning confirmed after 4 cycles.');

console.log('\n--- TEST 3b: it clears after 3 clean cycles, and unmeasured readings never confirm anything ---');
for (let i = 0; i < 2; i++) st = nextHairpinState(st, { liveRtt: 40, smoothedRtt: 40, spEdgeRtt: 35, usMiamiRtt: 118 });
assert(st.confirmed === true, 'two clean cycles are not enough to clear');
st = nextHairpinState(st, { liveRtt: 40, smoothedRtt: 40, spEdgeRtt: 35, usMiamiRtt: 118 });
assert(st.confirmed === false, 'three clean cycles clear it');
let blind: HairpinState = { confirmed: false, hairpinCount: 0, normalCount: 0 };
for (let i = 0; i < 10; i++) blind = nextHairpinState(blind, { liveRtt: 135, smoothedRtt: 135, spEdgeRtt: null, usMiamiRtt: null });
assert(blind.confirmed === false, 'no edge/Miami reading = no evidence of a detour');
assert.strictEqual(FORCED_HAIRPIN.confirmed, true);
console.log('Confirmed: hysteresis both ways, and missing data is not evidence.');

console.log('\n--- TEST 4: Anti-Flapping Deadband between Rank F and Rank B ---');
let currentRank: GamingRank = 'B';
const noisyPings = [64.0, 68.0, 63.5, 67.5, 65.0, 69.0, 64.5];
const rankHistory: string[] = [];
for (const p of noisyPings) {
  currentRank = rawRankWithHysteresis(currentRank, p, 1.2, 0, false, 5, false, 30, 'NONE');
  rankHistory.push(currentRank);
}
console.log('Rank history under noisy 63-69ms pings:', rankHistory);
assert(rankHistory.every((r) => r === 'B'), 'Deadband must prevent flapping');
console.log('Confirmed: 0 rank flip-flops observed in the 63-69ms region.');

console.log('\n--- TEST 5: Latency-First Golden Rule (Never declares ótimo on high latency) ---');
assert.strictEqual(rawRankWithHysteresis('B', 78, 1.2, 0, false, 4, false, 20, 'NONE'), 'F', 'RTT of 78ms must be Rank F');
assert.strictEqual(rawRankWithHysteresis('A', 52, 1.2, 0, false, 4, false, 20, 'NONE'), 'B', 'RTT of 52ms must be Rank B, never A or S');
assert.strictEqual(rawRankWithHysteresis('S', 36, 1.2, 0, false, 4, true, 20, 'NONE'), 'F', 'a detour forces F');
assert.strictEqual(rawRankWithHysteresis('F', 60, 1.2, 0, false, 4, false, 20, 'NONE'), 'B', 'F recovers below 68 ms');

console.log('\n--- TEST 6: The verdict never calls a slow connection good because the cloud queue is empty ---');
const slow = computeVerdict({
  metrics: metrics({ rttMs: 78, smoothedRttMs: 78 }),
  isHairpinning: false,
  serverStatus: server({ estimatedWaitMinutes: 0 }),
});
assert.strictEqual(slow.isGoodTimeToPlay, false);
assert.strictEqual(slow.rank, 'F');
assert.ok(slow.queueStatusText.includes('fila zerada') && slow.queueStatusText.includes('latência'), slow.queueStatusText);

const fine = computeVerdict({ metrics: metrics(), isHairpinning: false, serverStatus: server() });
assert.strictEqual(fine.isGoodTimeToPlay, true);
assert.ok(['S', 'A'].includes(fine.rank));

const detour = computeVerdict({ metrics: metrics({ rttMs: 135 }), isHairpinning: true, serverStatus: server() });
assert.strictEqual(detour.rank, 'F');
assert.strictEqual(detour.isGoodTimeToPlay, false);
assert.ok(detour.headline.includes('Hairpinning'), detour.headline);

const wifi = computeVerdict({ metrics: metrics({ isWifi24Ghz: true, jitterMs: 12, smoothedJitterMs: 12 }), isHairpinning: false, serverStatus: server() });
assert.strictEqual(wifi.rootCauseCategory, 'LOCAL_CONNECTION');
const bloat = computeVerdict({ metrics: metrics({ bufferbloatDeltaMs: 70 }), isHairpinning: false, serverStatus: server() });
assert.strictEqual(bloat.rank, 'B');
console.log('Confirmed: latency first; detour, Wi-Fi and bufferbloat are attributed to the right cause.');

console.log('\n✅ ALL RESILIENCE TESTS PASSED SUCCESSFULLY!');
