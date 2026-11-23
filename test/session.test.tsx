import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'url';
import { SessionPanel, entryDelta } from '../src/components/SessionPanel';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/find-session-peer.sh');

console.log('--- TEST 1: the game server is compared with the xCloud entry point in words ---');
assert.strictEqual(entryDelta({ rttP50: 45.4, entryRtt: 41.6 }).text, '+3.8 ms');
assert.ok(entryDelta({ rttP50: 45.4, entryRtt: 41.6 }).cls.includes('emerald'));
assert.ok(entryDelta({ rttP50: 56, entryRtt: 41 }).text.includes('um pouco mais longe'));
assert.ok(entryDelta({ rttP50: 120, entryRtt: 41 }).text.includes('alocada longe'), 'a Miami-like RTT means the match was placed far away');
assert.strictEqual(entryDelta({ rttP50: null, entryRtt: 41 }).text, '—', 'no ping answer: no claim');
assert.strictEqual(entryDelta({ rttP50: 45, entryRtt: null }).text, '—', 'no entry reading: no claim');
console.log('Confirmed.');

console.log('\n--- TEST 2: panel explains the limits ---');
const html = renderToStaticMarkup(<SessionPanel />);
assert.ok(html.includes('muda a cada sessão'));
assert.ok(html.includes('sudo'));
assert.ok(html.includes('nada é gravado nem enviado'));
assert.ok(html.includes('Nenhum servidor de sessão medido ainda.'));
console.log('Confirmed.');

if (process.platform !== 'win32') {
  console.log('\n--- TEST 3: the helper script picks the media flow out of a real capture ---');
  const media = `
19:47:38.823095 IP 13.104.105.250.1069 > 192.168.1.19.52012: UDP, length 96
19:47:38.823358 IP 192.168.1.19.52012 > 13.104.105.250.1069: UDP, length 64
19:47:38.923358 IP 13.104.105.250.1069 > 192.168.1.19.52012: UDP, length 1200
19:47:38.933358 IP 13.104.105.250.1069 > 192.168.1.19.52012: UDP, length 1200
19:47:39.118958 IP 192.168.1.19.52012 > 3.216.237.232.443: UDP, length 20
19:47:39.228369 IP 192.168.1.19.52012 > 185.231.233.49.3478: UDP, length 20
19:47:39.272383 IP 3.216.237.232.443 > 192.168.1.19.52012: UDP, length 76
19:47:39.300000 IP 192.168.1.19.5353 > 224.0.0.251.5353: UDP, length 5000
19:47:39.310000 IP 172.16.112.220.5000 > 192.168.1.19.5000: UDP, length 9000
`;
  const out = execFileSync('bash', [script, '--stdin'], { input: media, encoding: 'utf8' });
  assert.ok(out.includes('Servidor provável da sessão: 13.104.105.250   (porta 1069)'), out);
  assert.ok(!out.includes('224.0.0.251') && !out.includes('172.16.112.220'), 'multicast and private peers never win, however many bytes');
  const stunOnly = '19:47:39 IP 192.168.1.19.52012 > 185.231.233.49.3478: UDP, length 20\n';
  assert.ok(execFileSync('bash', [script, '--stdin'], { input: stunOnly, encoding: 'utf8' }).includes('185.231.233.49'));
  const none = spawnSync('bash', [script, '--stdin'], { input: '19:47 IP 192.168.1.19.1 > 10.0.0.2.2: UDP, length 100\n', encoding: 'utf8' });
  assert.strictEqual(none.status, 2, 'no public UDP flow = exit 2, no guess');
  if (process.getuid?.() !== 0) {
    const needRoot = spawnSync('bash', [script], { encoding: 'utf8' });
    assert.ok(needRoot.status !== 0, 'capturing without root must fail loudly');
  }
  console.log('Confirmed: media flow found; private/multicast ignored; no guess when nothing public.');
}

console.log('\n✅ ALL SESSION TESTS PASSED SUCCESSFULLY!');
