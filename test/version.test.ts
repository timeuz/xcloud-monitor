import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { findProblems, readVersions } from '../scripts/check-version';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('--- TEST 1: the repository versions are consistent ---');
const real = readVersions(root);
assert.deepStrictEqual(findProblems(real), [], JSON.stringify(real));
console.log(`Confirmed: ${real.tauriConf} in package.json, Cargo.toml and tauri.conf.json.`);

console.log('\n--- TEST 2: mismatches and bad tags are reported ---');
assert.ok(findProblems({ packageJson: '1.0.0', cargoToml: '1.0.1', tauriConf: '1.0.0' })[0].includes('versões diferentes'));
assert.deepStrictEqual(findProblems({ packageJson: '1.2.0', cargoToml: '1.2.0', tauriConf: '1.2.0' }, 'v1.2.0'), []);
assert.ok(findProblems({ packageJson: '1.2.0', cargoToml: '1.2.0', tauriConf: '1.2.0' }, 'v1.3.0')[0].includes('não corresponde'));
assert.ok(findProblems({ packageJson: 'abc', cargoToml: 'abc', tauriConf: 'abc' })[0].includes('inválida'));
console.log('Confirmed: drift between files or tag is caught before a release is built.');

console.log('\n✅ ALL VERSION GUARD TESTS PASSED SUCCESSFULLY!');
