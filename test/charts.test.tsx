import assert from 'assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimeSeriesChart, niceCeil, splitRuns } from '../src/components/charts/TimeSeriesChart';
import { HourProfileChart } from '../src/components/charts/HourProfileChart';

console.log('--- TEST 1: niceCeil rounds axis maxima to 1/2/5 steps ---');
assert.strictEqual(niceCeil(0), 1);
assert.strictEqual(niceCeil(0.7), 1);
assert.strictEqual(niceCeil(41.2), 50);
assert.strictEqual(niceCeil(120), 200);
assert.strictEqual(niceCeil(5), 5);
console.log('Confirmed: axis maxima are nice numbers.');

console.log('\n--- TEST 2: lines break on missing values and on gaps (app closed) ---');
const pts = [
  { t: 0, y: 10 },
  { t: 60, y: 11 },
  { t: 120, y: null },
  { t: 180, y: 12 },
  { t: 240, y: 13 },
  { t: 100_000, y: 14 }, // hours later: the app was off
];
const runs = splitRuns(pts, 150);
assert.strictEqual(runs.length, 3, JSON.stringify(runs));
assert.deepStrictEqual(runs.map((r) => r.length), [2, 2, 1]);
console.log('Confirmed: no line is drawn across missing data.');

console.log('\n--- TEST 3: chart markup ---');
const html = renderToStaticMarkup(
  <TimeSeriesChart
    ariaLabel="teste"
    from={0}
    to={3600}
    bucketSecs={120}
    series={[
      { id: 'a', label: 'Roteador', color: '#34d399', points: [{ t: 0, y: 1 }, { t: 120, y: 2 }, { t: 240, y: 1.5 }] },
      { id: 'b', label: 'xCloud', color: '#22d3ee', points: [{ t: 0, y: 40, hi: 55 }, { t: 120, y: 42, hi: 60 }] },
    ]}
    shades={[{ from: 600, to: 900, color: '#ef4444', label: 'Episódio' }]}
    marks={[{ t: 1200, color: '#f87171', label: 'Rota desviada' }]}
  />
);
assert.ok(html.includes('role="img"') && html.includes('aria-label="teste"'));
assert.strictEqual((html.match(/<polyline/g) || []).length, 3, 'two lines + one dashed p95 line');
assert.ok(html.includes('Episódio') && html.includes('Rota desviada'));
assert.ok(!html.includes('NaN') && !html.includes('Infinity'), 'no NaN/Infinity coordinates');
assert.ok(!html.includes('Sem dados neste período'));
console.log('Confirmed: lines, p95 dashes, shaded episode and mark are rendered with valid coordinates.');

console.log('\n--- TEST 4: empty chart says so and stays finite ---');
const empty = renderToStaticMarkup(
  <TimeSeriesChart ariaLabel="vazio" from={0} to={3600} bucketSecs={120} series={[{ id: 'a', label: 'x', color: '#fff', points: [] }]} />
);
assert.ok(empty.includes('Sem dados neste período'));
assert.ok(!empty.includes('NaN') && !empty.includes('Infinity'));
console.log('Confirmed: empty state.');

console.log('\n--- TEST 5: bars chart ---');
const bars = renderToStaticMarkup(
  <TimeSeriesChart
    ariaLabel="perda"
    kind="bars"
    unit="%"
    from={0}
    to={3600}
    bucketSecs={120}
    series={[{ id: 'l', label: 'Perda', color: '#f87171', points: [{ t: 0, y: 0 }, { t: 120, y: 5 }, { t: 240, y: 25 }] }]}
  />
);
assert.strictEqual((bars.match(/<rect/g) || []).length, 3);
assert.ok(!bars.includes('NaN'));
console.log('Confirmed: one bar per bucket.');

console.log('\n--- TEST 6: hour profile highlights peak hours ---');
const profile = Array.from({ length: 24 }, (_, h) => ({
  hour: h,
  days: 5,
  p50: h >= 20 && h <= 22 ? 62 : 36,
  p95: 70,
  lossPct: 0,
  jitter: 2,
}));
const hp = renderToStaticMarkup(<HourProfileChart ariaLabel="horas" profile={profile} peakHours={[20, 21, 22]} />);
assert.strictEqual((hp.match(/#f59e0b/g) || []).length, 3, 'exactly the three peak hours are amber');
assert.ok(!hp.includes('NaN'));
const hpEmpty = renderToStaticMarkup(<HourProfileChart ariaLabel="horas" profile={[]} peakHours={[]} />);
assert.ok(hpEmpty.includes('Ainda sem dados suficientes'));
console.log('Confirmed: peaks highlighted, empty state shown.');

console.log('\n✅ ALL CHART TESTS PASSED SUCCESSFULLY!');
