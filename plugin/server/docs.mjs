// Official API references, downloaded on first use and cached:
// Apple's App Store Connect OpenAPI spec and Google's Play discovery document.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipEntry } from './zip.mjs';
import { StoreError, dataDir, fetchRetry } from './util.mjs';

const ASC_SPEC_URL =
  'https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip';
const PLAY_DISCOVERY_URL = 'https://androidpublisher.googleapis.com/$discovery/rest?version=v3';
const DAY = 24 * 60 * 60 * 1000;

async function cached(name, maxAgeDays, fetchText) {
  const dir = join(dataDir(), 'reference');
  const file = join(dir, name);
  const s = await stat(file).catch(() => null);
  const saved = () => readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  // A broken copy (say, cut off mid-write) is downloaded again.
  const fresh = s && Date.now() - s.mtimeMs < maxAgeDays * DAY ? await saved() : null;
  if (fresh) return fresh;
  try {
    const text = await fetchText();
    const json = JSON.parse(text);
    // Written whole or not at all: a temp file, then rename.
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
    return json;
  } catch (err) {
    // An old copy beats none when offline.
    const old = s && (await saved());
    if (old) return old;
    throw new StoreError(`Couldn't download the API reference: ${err.message}`);
  }
}

async function download(url) {
  const res = await fetchRetry(url, {});
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Path template -> regex matching concrete paths.
const templateRegex = (t) =>
  new RegExp(`^${t.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`);

const clip = (s, n = 160) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

function rank(entries, query, fields) {
  const words = query.toLowerCase().split(/[\s,/]+/).filter(Boolean);
  const scored = [];
  for (const e of entries) {
    let score = 0;
    let all = true;
    for (const w of words) {
      let hit = 0;
      for (const [key, weight] of fields) if (String(e[key] ?? '').toLowerCase().includes(w)) hit = Math.max(hit, weight);
      if (!hit) all = false;
      score += hit;
    }
    if (all) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].path.length - b[1].path.length).map(([, e]) => e);
}

// ------------------------------------------------------------ App Store Connect

let ascIndex;
export async function ascSpec() {
  if (ascIndex) return ascIndex;
  const spec = await cached('asc-openapi.json', 14, async () =>
    unzipEntry(await download(ASC_SPEC_URL), (n) => n.endsWith('.json') && !n.includes('__MACOSX')).toString('utf8'),
  );
  const ops = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!op?.operationId) continue;
      ops.push({
        method: method.toUpperCase(),
        path,
        re: templateRegex(path),
        id: op.operationId,
        tags: (op.tags ?? []).join(' '),
        text: `${op.summary ?? ''} ${op.description ?? ''}`,
        op,
      });
    }
  }
  ascIndex = { spec, ops, version: spec.info?.version };
  return ascIndex;
}

export function ascFindOperation(index, method, path) {
  const bare = path.split('?')[0];
  return index.ops.find((o) => o.method === method && o.re.test(bare));
}

function resolveRef(spec, ref) {
  return ref.split('/').slice(1).reduce((o, k) => o?.[k], spec);
}

// The resource types a to-many relationship write lists in its
// {"data": [{"type", "id"}]} body, or null when the body is one resource.
export function ascLinkageTypes(index, op) {
  const deref = (s) => (s?.$ref ? resolveRef(index.spec, s.$ref) : s);
  const data = deref(deref(op.op.requestBody?.content?.['application/json']?.schema)?.properties?.data);
  if (data?.type !== 'array') return null;
  return deref(data.items)?.properties?.type?.enum ?? [];
}

// One parameter of an operation by name, $ref resolved.
export function ascParam(index, op, name) {
  for (const p of op.op.parameters ?? []) {
    const r = p.$ref ? resolveRef(index.spec, p.$ref) : p;
    if (r?.name === name) return r;
  }
  return null;
}

// Compact, depth-limited view of an OpenAPI schema.
function oas(spec, schema, depth, seen = new Set()) {
  if (!schema) return null;
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    if (depth <= 0 || seen.has(name)) return `<${name}>`;
    return oas(spec, resolveRef(spec, schema.$ref), depth, new Set([...seen, name]));
  }
  for (const k of ['oneOf', 'anyOf', 'allOf']) {
    if (schema[k]) return { [k]: schema[k].map((s) => oas(spec, s, depth - 1, seen)) };
  }
  if (schema.enum) return `${schema.type ?? 'string'}: ${schema.enum.slice(0, 30).join(' | ')}${schema.enum.length > 30 ? ' | …' : ''}`;
  if (schema.type === 'array') return [oas(spec, schema.items, depth, seen)];
  if (schema.type === 'object' || schema.properties) {
    if (depth <= 0) return 'object';
    const req = new Set(schema.required ?? []);
    const out = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      out[req.has(k) ? `${k}*` : k] = oas(spec, v, depth - 1, seen);
    }
    return out;
  }
  return [schema.type, schema.format, schema.nullable && 'nullable', schema.deprecated && 'deprecated'].filter(Boolean).join(' ');
}

export async function ascDocs({ search, path, method, schema }) {
  const index = await ascSpec();
  const { spec } = index;
  if (schema) {
    const s = spec.components?.schemas?.[schema];
    if (!s) throw new StoreError(`No schema named ${schema}`);
    return { schema, definition: oas(spec, s, 5) };
  }
  if (path) {
    const bare = path.replace(/^https:\/\/api\.appstoreconnect\.apple\.com/, '').split('?')[0];
    const matches = index.ops.filter((o) => (o.path === bare || o.re.test(bare)) && (!method || o.method === method.toUpperCase()));
    if (!matches.length) throw new StoreError(`No operation for ${method ?? 'any method'} ${bare}; search first`);
    return {
      api_version: index.version,
      operations: matches.map((o) => {
        const params = (o.op.parameters ?? []).map((p) => {
          const r = p.$ref ? resolveRef(spec, p.$ref) : p;
          const sch = r.schema?.items ?? r.schema ?? {};
          const values = sch.enum ? `: ${sch.enum.slice(0, 25).join(',')}${sch.enum.length > 25 ? ',…' : ''}` : '';
          return `${r.name}${r.required ? '*' : ''} (${r.in}) ${sch.type ?? ''}${values}`;
        });
        const bodyRef = o.op.requestBody?.content?.['application/json']?.schema;
        const ok = o.op.responses?.['200'] ?? o.op.responses?.['201'] ?? o.op.responses?.['204'];
        const okType = ok?.content && Object.keys(ok.content)[0];
        const okSchema = ok?.content?.[okType]?.schema;
        return {
          operation: `${o.method} ${o.path}`,
          id: o.id,
          ...(o.text.trim() && { about: clip(o.text, 300) }),
          parameters: params,
          ...(bodyRef && { body: oas(spec, bodyRef, 6) }),
          response: okSchema ? { type: okType, schema: oas(spec, okSchema, 3) } : (ok?.description ?? 'no content'),
        };
      }),
    };
  }
  if (!search) throw new StoreError('Give search, path or schema');
  const hits = rank(index.ops, search, [['path', 3], ['id', 3], ['tags', 2], ['text', 1]]);
  return {
    api_version: index.version,
    total: hits.length,
    operations: hits.slice(0, 40).map((o) => `${o.method} ${o.path}  (${o.id})`),
    next: 'Call again with path (and method) for parameters and body.',
  };
}

// ------------------------------------------------------------ Google Play

let playIndex;
export async function playDiscovery() {
  if (playIndex) return playIndex;
  const doc = await cached('play-discovery.json', 7, async () => (await download(PLAY_DISCOVERY_URL)).toString('utf8'));
  const methods = [];
  const walk = (resources) => {
    for (const r of Object.values(resources ?? {})) {
      for (const m of Object.values(r.methods ?? {})) {
        const path = m.flatPath ?? m.path;
        methods.push({ ...m, path, method: m.httpMethod, re: templateRegex(path), text: m.description ?? '' });
      }
      walk(r.resources);
    }
  };
  walk(doc.resources);
  playIndex = { doc, methods, revision: doc.revision };
  return playIndex;
}

export function playFindMethod(index, method, path) {
  const bare = path.split('?')[0].replace(/^\//, '');
  return index.methods.find((m) => m.method === method && m.re.test(bare));
}

function disc(doc, schema, depth, seen = new Set()) {
  if (!schema) return null;
  if (schema.$ref) {
    if (depth <= 0 || seen.has(schema.$ref)) return `<${schema.$ref}>`;
    return disc(doc, doc.schemas[schema.$ref], depth, new Set([...seen, schema.$ref]));
  }
  if (schema.enum) return `${schema.type}: ${schema.enum.join(' | ')}`;
  if (schema.type === 'array') return [disc(doc, schema.items, depth, seen)];
  if (schema.properties) {
    if (depth <= 0) return 'object';
    return Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, disc(doc, v, depth - 1, seen)]),
    );
  }
  return [schema.type, schema.format].filter(Boolean).join(' ');
}

export async function playDocs({ search, id, path, method }) {
  const index = await playDiscovery();
  const { doc } = index;
  let matches;
  if (id) matches = index.methods.filter((m) => m.id === id || m.id.endsWith(`.${id}`));
  else if (path) {
    const bare = path.replace(/^\//, '').split('?')[0];
    matches = index.methods.filter((m) => (m.path === bare || m.re.test(bare)) && (!method || m.method === method.toUpperCase()));
  }
  if (matches) {
    if (!matches.length) throw new StoreError('No matching Play API method; search first');
    return {
      revision: index.revision,
      methods: matches.map((m) => ({
        method: `${m.method} ${m.path}`,
        id: m.id,
        about: clip(m.description, 400),
        parameters: Object.entries(m.parameters ?? {}).map(
          ([k, p]) => `${k}${p.required ? '*' : ''} (${p.location}) ${p.type}${p.enum ? `: ${p.enum.join(',')}` : ''} ${clip(p.description, 100)}`,
        ),
        ...(m.request && { body: disc(doc, m.request, 5) }),
        ...(m.response && { response: disc(doc, m.response, 3) }),
        ...(m.supportsMediaUpload && { note: 'Media upload method; use the store-studio upload tools instead.' }),
      })),
    };
  }
  if (!search) throw new StoreError('Give search, id or path');
  const hits = rank(index.methods, search, [['path', 3], ['id', 3], ['text', 1]]);
  return {
    revision: index.revision,
    total: hits.length,
    methods: hits.slice(0, 40).map((m) => `${m.method} ${m.path}  (${m.id})`),
    next: 'Call again with id or path for parameters and body.',
  };
}
