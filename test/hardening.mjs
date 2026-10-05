// Retries never repeat a write the server may have acted on, and a broken
// reference cache is downloaded again instead of breaking the tools.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchRetry } from '../server/util.mjs';

const seen = [];
let reply;
globalThis.fetch = async (url, init = {}) => {
  seen.push(init.method ?? 'GET');
  return reply(seen.length);
};
// A tiny retry-after keeps the waits short.
const res = (status) => new Response(null, { status, headers: { 'retry-after': '0.001' } });
const dropped = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const attempt = async (init, expect) => {
  seen.length = 0;
  const out = await fetchRetry('https://store.example.com/', init, 2).then((r) => r.status, (e) => e.message);
  assert.deepEqual([out, seen.length], expect);
};

reply = (n) => res(n === 1 ? 500 : 200);
await attempt({ method: 'POST' }, [500, 1]); // the server may have acted on it
await attempt({}, [200, 2]);
await attempt({ method: 'PUT' }, [200, 2]);
reply = (n) => res(n === 1 ? 429 : 201);
await attempt({ method: 'POST' }, [201, 2]); // 429: the server did nothing
reply = () => {
  throw dropped('ECONNRESET');
};
await attempt({ method: 'POST' }, ['fetch failed', 1]);
reply = (n) => {
  if (n === 1) throw dropped('ECONNREFUSED');
  return res(201);
};
await attempt({ method: 'POST' }, [201, 2]); // never connected

const data = mkdtempSync(join(tmpdir(), 'store-studio-cache-'));
const previous = process.env.STORE_STUDIO_DATA;
process.env.STORE_STUDIO_DATA = data;
mkdirSync(join(data, 'reference'));
writeFileSync(join(data, 'reference/play-discovery.json'), '{"revision": "cut off');
reply = () => new Response(JSON.stringify({ revision: 'fresh', schemas: {}, resources: {} }));
const { playDiscovery } = await import('../server/docs.mjs?broken-cache');
assert.equal((await playDiscovery()).revision, 'fresh');
assert.equal(JSON.parse(readFileSync(join(data, 'reference/play-discovery.json'), 'utf8')).revision, 'fresh');
assert.deepEqual(readdirSync(join(data, 'reference')), ['play-discovery.json'], 'no temp file left behind');
process.env.STORE_STUDIO_DATA = previous;

console.log('hardening checks passed');
