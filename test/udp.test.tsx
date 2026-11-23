import assert from 'assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UdpPanel, udpVerdict } from '../src/components/UdpPanel';

console.log('--- TEST 1: plain-words verdict from loss and burst ---');
assert.strictEqual(udpVerdict(0, 0).text, 'Sem perda');
assert.strictEqual(udpVerdict(0.4, 1).text, 'Perda mínima');
assert.strictEqual(udpVerdict(0.4, 3).text, 'Perda leve', 'a burst of 3 is not "minimal" even at low loss');
assert.strictEqual(udpVerdict(0.4, 8).text, 'Perda perceptível no vídeo', '8 packets in a row is a 160 ms hole at 50 pps');
assert.strictEqual(udpVerdict(2, 4).text, 'Perda leve');
assert.strictEqual(udpVerdict(2, 12).text, 'Perda perceptível no vídeo');
assert.strictEqual(udpVerdict(6, 2).text, 'Perda perceptível no vídeo');
console.log('Confirmed: burst loss matters as much as the average.');

console.log('\n--- TEST 2: panel states what it does and what it does not ---');
const html = renderToStaticMarkup(<UdpPanel />);
assert.ok(html.includes('Rodar teste UDP'));
assert.ok(html.includes('50 pacotes por segundo'));
assert.ok(html.includes('não mede banda'), 'must not pretend to measure bandwidth');
assert.ok(html.includes('Nenhum teste UDP ainda.'));
console.log('Confirmed: honest description and empty state.');

console.log('\n✅ ALL UDP PANEL TESTS PASSED SUCCESSFULLY!');
