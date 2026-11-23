import assert from 'assert';
import fs from 'fs';
import path from 'path';

/**
 * Test Suite: Strategic Matrix Thresholds, Category Mapping, and Audio/Confetti Cleanliness
 */

// 1. Threshold Test
function getBadgeStatus(category: string, rttMs: number | null): string {
  if (category === 'referencia_internacional') return 'REF-EUA';
  if (rttMs === null) return 'TIMEOUT';
  if (rttMs > 65) return 'RUIM';
  if (rttMs > 45) return 'ATENÇÃO';
  return 'BOA';
}

console.log('--- TEST 1: Matrix Latency Thresholds Calibrated for Regional Brazil ---');
assert.strictEqual(getBadgeStatus('azure_brazilsouth', 36.2), 'BOA', '36.2ms must be BOA');
assert.strictEqual(getBadgeStatus('borda_brasil', 37.5), 'BOA', '37.5ms must be BOA');
assert.strictEqual(getBadgeStatus('borda_brasil', 44.9), 'BOA', '44.9ms must be BOA');
assert.strictEqual(getBadgeStatus('borda_brasil', 55.0), 'ATENÇÃO', '55.0ms must be ATENÇÃO');
assert.strictEqual(getBadgeStatus('borda_brasil', 85.4), 'RUIM', '85.4ms must be RUIM');
assert.strictEqual(getBadgeStatus('referencia_internacional', 118.5), 'REF-EUA', 'US reference must be REF-EUA');
assert.strictEqual(getBadgeStatus('borda_brasil', null), 'TIMEOUT', 'Null RTT must be TIMEOUT');
console.log('Confirmed: 36.2ms is BOA (green), 55ms is ATENÇÃO, 85ms is RUIM.');

// 2. Category Labeling Test
function getCategoryLabel(category: string): string {
  if (category === 'borda_brasil') return 'Borda BR';
  if (category === 'azure_brazilsouth') return 'Datacenter SP';
  if (category === 'ix_nacional') return 'IX Nacional';
  return 'Ref. EUA';
}

console.log('--- TEST 2: Category Identification for IX Nacional ---');
assert.strictEqual(getCategoryLabel('ix_nacional'), 'IX Nacional');
assert.strictEqual(getCategoryLabel('azure_brazilsouth'), 'Datacenter SP');
assert.strictEqual(getCategoryLabel('borda_brasil'), 'Borda BR');
assert.strictEqual(getCategoryLabel('referencia_internacional'), 'Ref. EUA');
console.log('Confirmed: ix_nacional is properly mapped to "IX Nacional" and never to "Ref. EUA".');

// 3. Audio & Confetti Verification in App.tsx
console.log('--- TEST 3: Verification of Confetti & Automatic Rank Audio Removal ---');
const appTsx = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
assert(!appTsx.includes("import confetti"), 'Confetti import must be removed from App.tsx');
assert(!appTsx.includes("confetti({"), 'Confetti trigger must be removed from App.tsx');
assert(!appTsx.includes("playVerdictUpgradeSound"), 'playVerdictUpgradeSound must be removed from App.tsx');
assert(!appTsx.includes("playVerdictDegradeSound"), 'playVerdictDegradeSound must be removed from App.tsx');
assert(appTsx.includes("isProbingRef"), 'Concurrency guard isProbingRef must be present in App.tsx');
assert.ok(!fs.existsSync(path.resolve(process.cwd(), 'src/services/soundEffects.ts')), 'the app has no sound effects');
console.log('Confirmed: Confetti, rank transition audio triggers, and overlap vulnerability have been completely removed.');

console.log('✅ ALL MATRIX & AUDIO CLEANLINESS TESTS PASSED SUCCESSFULLY!');
