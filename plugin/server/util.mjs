import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Thrown for problems the user can fix; the message is shown as-is.
export class StoreError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

export const b64url = (buf) => Buffer.from(buf).toString('base64url');

export const md5 = (buf) => createHash('md5').update(buf).digest('hex');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Natural sort so 2.png comes before 10.png.
export const naturalSort = (a, b) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export const charCount = (s) => [...(s ?? '')].length;

// Runs fn over items with at most `limit` in flight, keeping result order.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Requests that are safe to send twice.
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
// Network failures where the request never reached the server.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

// Retries with backoff: reads on network errors, 429 and 5xx; writes such as
// POST only when the server can't have acted on them (429, connection never
// made), so a slow or failing server never gets the same change twice.
export async function fetchRetry(url, init, tries = 4) {
  const idempotent = IDEMPOTENT.has((init?.method ?? 'GET').toUpperCase());
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= tries - 1 || !(idempotent || NOT_SENT.has(err?.cause?.code ?? err?.code))) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if ((res.status === 429 || (idempotent && res.status >= 500)) && attempt < tries - 1) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
      await sleep(Math.min(wait, 30000));
      continue;
    }
    return res;
  }
}

// URL parsing rewrites some paths before they are sent: dot segments (also
// percent-encoded as %2e), backslashes, tabs and newlines. A path must reach
// the store exactly as written, so blocklists and reference checks see what
// the store sees. Takes a path or a full URL; the query is not checked.
export function assertPlainPath(pathOrUrl) {
  const s = String(pathOrUrl);
  // Without URL parsing, which would hide what this looks for.
  const start = s.startsWith('https://') ? s.indexOf('/', 'https://'.length) : 0;
  const path = start < 0 ? '' : s.slice(start).split('?')[0];
  const bad =
    /[#\u0000-\u001f\u007f]/.test(s) ||
    /[\\\s]|%(2f|5c)/i.test(path) ||
    path.split('/').some((seg) => /^(\.|%2e){1,2}$/i.test(seg));
  if (bad) throw new StoreError(`Refusing the path ${JSON.stringify(s.slice(0, 200))}: no "." or ".." segments, backslashes, encoded slashes, "#" or control characters.`);
}

// Only https URLs whose host is `domain` or one of its subdomains.
export function assertHost(url, domains) {
  const u = new URL(url);
  const ok =
    u.protocol === 'https:' &&
    domains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
  if (!ok) throw new StoreError(`Refusing unexpected URL host: ${u.hostname}`);
}

// A plugin setting as Claude Code hands it over: unset ones can arrive empty or
// as the literal placeholder.
export function clean(value) {
  const s = (value ?? '').trim();
  return !s || s.startsWith('${') ? undefined : s;
}

// Cache for downloaded API references and report files.
export const dataDir = () => clean(process.env.STORE_STUDIO_DATA) ?? join(homedir(), '.cache', 'store-studio');

export const SETTINGS_HINT =
  'Add it in the plugin settings: run /plugin, open store-studio on the Installed tab and choose Configure options (the store-setup skill walks through it). Key contents go into that dialog, never into the chat.';

// A private key pasted into the plugin settings, as PEM. Pasting can turn line
// breaks into spaces or literal \n, or drop the BEGIN/END lines, so the base64
// body is re-wrapped. `what` names the setting in errors; the value is never quoted.
export function pemKey(text, what) {
  const s = String(text ?? '').replace(/\\n/g, '\n').trim();
  if (/^[~/]/.test(s) || /^[A-Za-z]:\\/.test(s)) {
    throw new StoreError(`${what} holds a file path. Paste the contents of the key file instead. ${SETTINGS_HINT}`);
  }
  const label = s.match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----/)?.[1] ?? 'PRIVATE KEY';
  const body = s.replace(/-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) {
    throw new StoreError(`${what} isn't a private key. Paste the whole key, including the BEGIN and END lines. ${SETTINGS_HINT}`);
  }
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
