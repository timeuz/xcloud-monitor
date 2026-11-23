import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

console.log('--- TEST 1: the UI loads nothing from the internet ---');
const html = read('index.html');
assert.ok(!/(?:src|href)=["']https?:\/\//.test(html), 'index.html must not load external scripts, styles or fonts');
assert.ok(!/googleapis|gstatic/.test(html));
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
  assert.ok(!/googleapis|gstatic/.test(csp), 'CSP must not whitelist font CDNs');
  assert.ok(/font-src 'self'/.test(csp));
}
console.log('Confirmed: no CDN references in index.html or the CSP.');

console.log('\n--- TEST 2: fonts are bundled and the CSS names match the bundled families ---');
const main = read('src/main.tsx');
assert.ok(main.includes("@fontsource-variable/plus-jakarta-sans") && main.includes("@fontsource-variable/jetbrains-mono"));
const css = read('src/index.css');
assert.ok(css.includes("'Plus Jakarta Sans Variable'") && css.includes("'JetBrains Mono Variable'"));
for (const pkg of ['plus-jakarta-sans', 'jetbrains-mono']) {
  const dir = path.join(root, 'node_modules/@fontsource-variable', pkg, 'files');
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.woff2')), `${pkg} woff2 files missing`);
}
// the generic fallbacks must be real system stacks, so a missing font never leaves text unstyled
assert.ok(/--font-sans:[^;]*system-ui/.test(css) && /--font-mono:[^;]*monospace/.test(css));
console.log('Confirmed: fonts ship with the app, with system fallbacks.');

console.log('\n--- TEST 3: no Express or web-server leftovers ---');
const pkg = JSON.parse(read('package.json'));
const all = { ...pkg.dependencies, ...pkg.devDependencies };
for (const gone of ['express', 'dotenv', 'openai']) assert.ok(!(gone in all), `${gone} must not be a dependency`);
assert.ok(!fs.existsSync(path.join(root, 'server.ts')));
assert.strictEqual(pkg.scripts.dev, 'vite');
console.log('Confirmed: desktop-only dependency set.');

console.log('\n✅ ALL OFFLINE TESTS PASSED SUCCESSFULLY!');
