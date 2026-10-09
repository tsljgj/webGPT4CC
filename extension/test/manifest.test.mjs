// Static checks for the unpacked extension: manifest shape, referenced files,
// syntax of every script, and constants that two files must agree on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(EXT, rel), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('manifest: MV3 with the documented permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  // No "tabs": the chatgpt.com host permission already reveals the URLs we need, and
  // "tabs" would hand the service worker every site's URL (and a browsing-history warning).
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'storage']);
  assert.deepEqual([...manifest.host_permissions].sort(), ['http://127.0.0.1/*', 'http://localhost/*', 'https://chatgpt.com/*']);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.action.default_popup, 'popup.html');
});

test('manifest: content scripts (MAIN agent after its core, ISOLATED relay, both at document_start)', () => {
  const [main, isolated] = manifest.content_scripts;
  assert.deepEqual(main.matches, ['https://chatgpt.com/*']);
  assert.deepEqual(main.js, ['content/stream-core.js', 'content/page-agent.js']);
  assert.equal(main.world, 'MAIN');
  assert.equal(main.run_at, 'document_start');
  assert.deepEqual(isolated.matches, ['https://chatgpt.com/*']);
  assert.deepEqual(isolated.js, ['content/relay.js']);
  assert.ok(!isolated.world || isolated.world === 'ISOLATED');
  assert.equal(isolated.run_at, 'document_start');
});

test('every file referenced by the manifest and popup.html exists', () => {
  const files = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action.default_icon || {}),
  ]);
  const html = read('popup.html');
  for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) files.add(m[1]);
  for (const f of files) assert.ok(existsSync(join(EXT, f)), `missing ${f}`);
  for (const [size, f] of Object.entries(manifest.icons)) {
    const png = readFileSync(join(EXT, f));
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', `${f} is not a PNG`);
    assert.equal(png.readUInt32BE(16), Number(size), `${f} width`);
  }
});

test('every extension script parses', () => {
  const scripts = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(EXT, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(m?js)$/.test(e.name)) scripts.push(rel);
    }
  };
  walk('.');
  assert.ok(scripts.length >= 6);
  for (const s of scripts) {
    const r = spawnSync(process.execPath, ['--check', join(EXT, s)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${s}: ${r.stderr}`);
  }
});

test('page-agent.js and relay.js share the channel tag; relay.js and background.js share the port name', () => {
  const channel = (src) => /const CHANNEL = '([^']+)'/.exec(src)?.[1];
  assert.ok(channel(read('content/page-agent.js')));
  assert.equal(channel(read('content/page-agent.js')), channel(read('content/relay.js')));
  const relayPort = /const PORT_NAME = '([^']+)'/.exec(read('content/relay.js'))?.[1];
  const swPort = /const RELAY_PORT_NAME = '([^']+)'/.exec(read('background.js'))?.[1];
  assert.ok(relayPort);
  assert.equal(relayPort, swPort);
});

test('protocol constants match the bridge', () => {
  const bridge = readFileSync(join(EXT, '..', 'bridge', 'src', 'providers', 'extension.ts'), 'utf8');
  const bridgeProto = /export const PROTOCOL_VERSION = (\d+)/.exec(bridge)?.[1];
  const extProto = /const PROTOCOL_VERSION = (\d+)/.exec(read('background.js'))?.[1];
  assert.equal(extProto, bridgeProto);
  const pkg = JSON.parse(readFileSync(join(EXT, '..', 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version, 'manifest version should follow package.json');
});
