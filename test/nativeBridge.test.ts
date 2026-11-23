import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as bridge from '../src/services/nativeBridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  throw new Error('expected a rejection');
}

async function testOutsideTauri() {
  console.log('--- TEST 1: outside the desktop app nothing is faked, everything refuses ---');
  delete (globalThis as any).window;
  assert.strictEqual(bridge.isTauriApp(), false);
  for (const call of [
    () => bridge.fetchTelemetryProbe(),
    () => bridge.executeBufferbloatTest(),
    () => bridge.fetchTracerouteReport(),
    () => bridge.fetchAiStatus(),
    () => bridge.saveAiKey('x'),
    () => bridge.fetchHistorySeries(24),
    () => bridge.checkForUpdate(),
  ]) {
    assert.match(await rejects(call()), /desktop/i);
  }
  console.log('Confirmed: no HTTP fallbacks, no invented data.');
}

async function testCommandNamesAndArguments() {
  console.log('\n--- TEST 2: each bridge function calls the right command with the right arguments ---');
  const calls: Array<[string, any]> = [];
  const answers: Record<string, any> = {
    probe_telemetry: { azureRtt: 41.5, endpoints: [] },
    ai_status: { enabled: true },
    update_check: null,
  };
  (globalThis as any).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: any) => {
        calls.push([cmd, args]);
        return answers[cmd];
      },
    },
  };
  assert.strictEqual(bridge.isTauriApp(), true);

  assert.strictEqual((await bridge.fetchTelemetryProbe('1.2.3.4')).azureRtt, 41.5);
  assert.deepStrictEqual(calls.pop(), ['probe_telemetry', { customHost: '1.2.3.4' }]);


  await bridge.fetchHistorySeries(24);
  assert.deepStrictEqual(calls.pop(), ['history_series', { windowHours: 24 }]);

  await bridge.setHistoryEnabled(false);
  assert.deepStrictEqual(calls.pop(), ['history_set_enabled', { enabled: false }]);

  assert.strictEqual(await bridge.checkForUpdate(), null);
  await bridge.saveAiKey('sk-test');
  assert.deepStrictEqual(calls.pop(), ['ai_save_key', { apiKey: 'sk-test' }]);
  console.log('Confirmed: command names and argument keys.');

  delete (globalThis as any).window;
}

/** Splits `a: T<x, y>, b: U` on top-level commas. */
function splitParams(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of src) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function testBridgeMatchesRustContract() {
  console.log('\n--- TEST 3: every command the frontend invokes exists in Rust, with matching argument names ---');
  const rustFiles = fs.readdirSync(path.join(root, 'src-tauri/src')).filter((f) => f.endsWith('.rs'));
  const rust = rustFiles.map((f) => fs.readFileSync(path.join(root, 'src-tauri/src', f), 'utf8')).join('\n');

  const registered = new Set<string>();
  const handler = rust.match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(handler, 'generate_handler! not found');
  for (const item of handler![1].split(',')) {
    const name = item.trim().split('::').pop();
    if (name) registered.add(name);
  }

  // Rust params per command (State / AppHandle are injected by Tauri, not sent by JS)
  const params = new Map<string, Set<string>>();
  for (const m of rust.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g)) {
    const keys = new Set<string>();
    for (const p of splitParams(m[2])) {
      const [name, type] = [p.split(':')[0].trim(), p.slice(p.indexOf(':') + 1)];
      if (/State<|AppHandle|Window|WebviewWindow/.test(type)) continue;
      keys.add(camel(name));
    }
    params.set(m[1], keys);
  }

  const ts = fs.readFileSync(path.join(root, 'src/services/nativeBridge.ts'), 'utf8');
  const used = new Map<string, Set<string>>();
  for (const m of ts.matchAll(/invokeTauri(?:<[^>]*>)?\(\s*'(\w+)'(?:\s*,\s*(\{[^}]*\}|\w+))?/g)) {
    const keys = used.get(m[1]) ?? new Set<string>();
    if (m[2]?.startsWith('{')) {
      // top-level keys only: after `{` or `,`, followed by `:` `,` or `}`
      for (const k of m[2].matchAll(/[{,]\s*(\w+)\s*(?=[:,}])/g)) keys.add(k[1]);
    }
    used.set(m[1], keys);
  }
  assert.ok(used.size > 20, `expected many invoked commands, found ${used.size}`);

  for (const [cmd, keys] of used) {
    assert.ok(registered.has(cmd), `frontend invokes "${cmd}" but Rust does not register it`);
    const rustKeys = params.get(cmd);
    assert.ok(rustKeys, `no #[tauri::command] fn found for "${cmd}"`);
    for (const k of keys) {
      if (k === 'payload') continue; // spread object (ai_chat): checked below
      assert.ok(rustKeys!.has(k), `"${cmd}": frontend sends "${k}" but Rust expects ${[...rustKeys!].join(', ') || 'no arguments'}`);
    }
  }
  assert.deepStrictEqual([...params.get('ai_chat')!].sort(), ['context', 'history', 'message']);
  console.log(`Confirmed: ${used.size} invoked commands are registered in Rust and their argument names match.`);
}

async function main() {
  await testOutsideTauri();
  await testCommandNamesAndArguments();
  testBridgeMatchesRustContract();
  console.log('\n✅ ALL NATIVE BRIDGE TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
