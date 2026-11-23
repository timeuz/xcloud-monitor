/**
 * Release guard: package.json, Cargo.toml and tauri.conf.json must carry the same version, and a release
 * tag (when given) must be `v<version>`. Mismatched versions break the updater (it compares versions).
 *
 * Usage: tsx scripts/check-version.ts [vX.Y.Z]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface Versions {
  packageJson: string;
  cargoToml: string;
  tauriConf: string;
}

export function readVersions(root: string): Versions {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tauri = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const m = cargo.match(/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms);
  return { packageJson: String(pkg.version), cargoToml: m ? m[1] : '(não encontrada)', tauriConf: String(tauri.version) };
}

export function findProblems(v: Versions, tag?: string): string[] {
  const problems: string[] = [];
  const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
  for (const [file, version] of Object.entries(v)) {
    if (!semver.test(version)) problems.push(`${file}: versão inválida "${version}"`);
  }
  if (new Set(Object.values(v)).size > 1) {
    problems.push(`versões diferentes: package.json=${v.packageJson}, Cargo.toml=${v.cargoToml}, tauri.conf.json=${v.tauriConf}`);
  }
  if (tag && tag !== `v${v.tauriConf}`) {
    problems.push(`a tag "${tag}" não corresponde à versão do app (esperado v${v.tauriConf})`);
  }
  return problems;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tag = process.argv[2] || undefined;
  const versions = readVersions(root);
  const problems = findProblems(versions, tag);
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`✓ versão ${versions.tauriConf} consistente${tag ? ` com a tag ${tag}` : ''}`);
}
