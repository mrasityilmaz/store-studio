import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppStoreConnect } from './asc.mjs';
import { GooglePlay } from './play.mjs';
import { StoreError, clean, pemKey, setupHint } from './util.mjs';

// ---------------------------------------------------------------- accounts

// Accounts come from two places:
// - The plugin settings, as Claude Code hands them to this server: up to two
//   per store, key contents from the system's secure storage.
// - Accounts the user connected in the chat with account_add: the accounts
//   file holds their IDs and key file paths, never key contents.
// Each settings slot is [name, ...values] in the order of ASC_FIELDS / PLAY_FIELDS.
const ASC_FIELDS = ['keyId', 'issuerId', 'privateKey'];
const PLAY_FIELDS = ['serviceAccount'];

function settings() {
  const {
    ASC_NAME, ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY,
    ASC_2_NAME, ASC_2_KEY_ID, ASC_2_ISSUER_ID, ASC_2_PRIVATE_KEY,
    PLAY_NAME, PLAY_SERVICE_ACCOUNT,
    PLAY_2_NAME, PLAY_2_SERVICE_ACCOUNT,
  } = process.env;
  return {
    asc: [
      [ASC_NAME, ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY],
      [ASC_2_NAME, ASC_2_KEY_ID, ASC_2_ISSUER_ID, ASC_2_PRIVATE_KEY],
    ],
    play: [
      [PLAY_NAME, PLAY_SERVICE_ACCOUNT],
      [PLAY_2_NAME, PLAY_2_SERVICE_ACCOUNT],
    ],
  };
}

export const accountsFile = () => join(homedir(), '.config', 'store-studio', 'accounts.json');

// Paths under home are saved as ~/… (with / on every system).
export const expandHome = (p) => (typeof p === 'string' && /^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p);

// Size and change time of a key file, so a replaced file is noticed.
const stamp = (path) => {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
};

// The accounts file, re-read on every call so a new account applies at once.
export function connectedAccounts() {
  const file = accountsFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new StoreError(`Can't read the accounts file ${file}; fix or delete it, then connect the accounts again.`);
  }
}

const slug = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

// Whether a settings copy of a key can sign in as written: a key that parses
// (not cut to its first line, not a path). Used to decide whether it hides a
// connected account with the same key.
function parses(text) {
  try {
    createPrivateKey(pemKey(text, 'key'));
    return true;
  } catch {
    return false;
  }
}

// The service account e-mail behind a Play account, to spot the same key in
// both places; null when it can't be read. Key files are read once per change.
const emails = new Map();
function playEmail(a) {
  try {
    if (!a.serviceAccountPath) return JSON.parse(a.serviceAccount).client_email ?? null;
    const now = stamp(a.serviceAccountPath);
    const known = emails.get(a.serviceAccountPath);
    if (known?.stamp === now) return known.email;
    const email = JSON.parse(readFileSync(a.serviceAccountPath, 'utf8')).client_email ?? null;
    emails.set(a.serviceAccountPath, { stamp: now, email });
    return email;
  } catch {
    return null;
  }
}

function playWorks(a) {
  try {
    const sa = JSON.parse(a.serviceAccount);
    return sa.type === 'service_account' && Boolean(sa.client_email) && parses(sa.private_key);
  } catch {
    return false;
  }
}

// Named accounts per store. Settings slots come first; a slot without a name
// is called app-store / google-play (plus -2 for the second). A key that is
// both in the settings and connected in the chat is listed once: under its
// settings name when that copy can sign in, else the connected account takes
// its place (that is what the settings errors tell the user to do).
export function accounts() {
  const out = { asc: {}, play: {} };
  const all = settings();
  const add = (store, base, entry) => {
    let key = base;
    for (let n = 2; out[store][key]; n++) key = `${base}-${n}`;
    out[store][key] = entry;
  };
  for (const [store, fallback, fields] of [['asc', 'app-store', ASC_FIELDS], ['play', 'google-play', PLAY_FIELDS]]) {
    all[store].forEach(([name, ...slot], i) => {
      const values = Object.fromEntries(fields.map((field, j) => [field, clean(slot[j])]));
      if (!Object.values(values).some(Boolean)) return;
      add(store, slug(clean(name)) || (i ? `${fallback}-${i + 1}` : fallback), { ...values, source: `settings slot ${i + 1}` });
    });
  }
  const file = connectedAccounts();
  const ascSettings = Object.entries(out.asc);
  for (const [name, a] of Object.entries(file.app_store ?? {})) {
    const keyId = a?.key_id;
    const twin = keyId && ascSettings.find(([, x]) => x.keyId === keyId);
    if (twin) {
      const [listed, x] = twin;
      const sameIssuer = String(x.issuerId ?? '').toLowerCase() === String(a?.issuer_id ?? '').toLowerCase();
      if (sameIssuer && parses(x.privateKey)) continue;
      delete out.asc[listed];
    }
    add('asc', slug(name) || 'app-store', { keyId, issuerId: a?.issuer_id, keyPath: expandHome(a?.private_key), source: 'connected in chat' });
  }
  const playSettings = Object.entries(out.play).map(([listed, x]) => [listed, playEmail(x), x]);
  for (const [name, a] of Object.entries(file.google_play ?? {})) {
    const entry = { serviceAccountPath: expandHome(a?.service_account), source: 'connected in chat' };
    if (playSettings.length) {
      const email = playEmail(entry);
      const twin = email && playSettings.find(([, e]) => e === email);
      if (twin) {
        if (playWorks(twin[2])) continue;
        delete out.play[twin[0]];
      }
    }
    add('play', slug(name) || 'google-play', entry);
  }
  return out;
}

function pickAccount(all, account, store) {
  const names = Object.keys(all);
  if (!names.length) throw new StoreError(`${store} isn't set up. ${setupHint()}`);
  if (account) {
    if (!all[account]) throw new StoreError(`No ${store} account named "${account}" (set up: ${names.join(', ')})`);
    return account;
  }
  if (names.length === 1) return names[0];
  throw new StoreError(`Several ${store} accounts are set up (${names.join(', ')}); name one in the account parameter.`);
}

const ascClients = new Map();
const playClients = new Map();

function ascClient(name, c) {
  const missing = [!c.keyId && 'key ID', !c.issuerId && 'issuer ID', !c.privateKey && !c.keyPath && 'private key'].filter(Boolean);
  if (missing.length) throw new StoreError(`App Store Connect account "${name}" is missing its ${missing.join(', ')}. ${setupHint()}`);
  // A key file replaced under the same path (account_add with replace) gets a new client.
  const fingerprint = JSON.stringify({ ...c, stamp: c.keyPath ? stamp(c.keyPath) : null });
  if (ascClients.get(name)?.fingerprint !== fingerprint) ascClients.set(name, { fingerprint, client: new AppStoreConnect(c) });
  return ascClients.get(name).client;
}

function playClient(name, c) {
  if (!c.serviceAccount && !c.serviceAccountPath) throw new StoreError(`Google Play account "${name}" has no service account key. ${setupHint()}`);
  const fingerprint = JSON.stringify({ ...c, stamp: c.serviceAccountPath ? stamp(c.serviceAccountPath) : null });
  if (playClients.get(name)?.fingerprint !== fingerprint) {
    playClients.set(name, { fingerprint, client: new GooglePlay(c) });
  }
  return playClients.get(name).client;
}

/** App Store Connect client for `account`, or for the only account set up. */
export function asc(account) {
  const all = accounts().asc;
  const name = pickAccount(all, account, 'App Store Connect');
  return ascClient(name, all[name]);
}

/** Google Play client for `account`, or for the only account set up. */
export function play(account) {
  const all = accounts().play;
  const name = pickAccount(all, account, 'Google Play');
  return playClient(name, all[name]);
}

export const ascAccountNames = () => Object.keys(accounts().asc);
export const playAccountNames = () => Object.keys(accounts().play);

// Which account answered for an app last time, so lookups don't repeat.
const ascByApp = new Map();
const playByPackage = new Map();

const ordered = (names, known) => (known && names.includes(known) ? [known, ...names.filter((n) => n !== known)] : names);

/**
 * Finds the App Store Connect account that can see `app` (bundle ID or Apple
 * ID) and returns { client, account, app }.
 */
export async function ascForApp(app, account) {
  const names = ascAccountNames();
  if (account || names.length <= 1) {
    const client = asc(account);
    return { client, account: account ?? names[0], app: await client.app(app) };
  }
  const failures = [];
  // One account with a problem (a missing field, an unreadable key) doesn't
  // stop the search; it is reported with the others.
  for (const name of ordered(names, ascByApp.get(app))) {
    try {
      const client = asc(name);
      const found = await client.app(app);
      ascByApp.set(app, name);
      return { client, account: name, app: found };
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  throw new StoreError(`None of the App Store Connect accounts can see ${app}`, failures);
}

/** Finds the Google Play account that can open an edit for `pkg`. */
export async function playForPackage(pkg, account) {
  const names = playAccountNames();
  if (account || names.length <= 1) return { client: play(account), account: account ?? names[0] };
  const known = playByPackage.get(pkg);
  if (known && names.includes(known)) return { client: play(known), account: known };
  const failures = [];
  for (const name of names) {
    try {
      const client = play(name);
      await client.withEdit(pkg, async () => {});
      playByPackage.set(pkg, name);
      return { client, account: name };
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  }
  throw new StoreError(`None of the Google Play accounts can open ${pkg}`, failures);
}

// ---------------------------------------------------------------- helpers

export const CONFIRM =
  'Dry run: nothing was changed. Show this plan to the user and run again with dry_run: false only after they explicitly confirm.';

export const preview = (s, n = 90) => {
  if (s == null) return null;
  const flat = String(s).replace(/\s+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};
