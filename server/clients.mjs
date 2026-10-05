import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppStoreConnect } from './asc.mjs';
import { GooglePlay } from './play.mjs';
import { StoreError, envValue } from './util.mjs';

// ---------------------------------------------------------------- accounts

export const SETUP_HINT =
  'Set it in the plugin options (run /plugin, open store-studio, configure) or in the accounts file, and see the store-setup skill.';

const expand = (p) => (typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export const accountsFile = () =>
  envValue('STORE_STUDIO_ACCOUNTS') ?? join(homedir(), '.config', 'store-studio', 'accounts.json');

// Named accounts per store. The plugin options are the "default" account; the
// accounts file adds more. Only IDs and key file paths live in either, never
// key contents. The file is re-read on every call, so edits apply at once.
export function accounts() {
  const out = { asc: {}, play: {} };
  const asc = {
    keyId: envValue('ASC_KEY_ID'),
    issuerId: envValue('ASC_ISSUER_ID'),
    keyPath: envValue('ASC_PRIVATE_KEY_PATH'),
  };
  if (asc.keyId || asc.issuerId || asc.keyPath) out.asc.default = asc;
  const sa = envValue('PLAY_SERVICE_ACCOUNT_PATH');
  if (sa) out.play.default = { serviceAccountPath: sa };

  const file = accountsFile();
  if (existsSync(file)) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new StoreError(`Can't read the accounts file ${file}: ${err.message}`);
    }
    for (const [name, a] of Object.entries(data.app_store ?? {})) {
      out.asc[name] = { keyId: a.key_id, issuerId: a.issuer_id, keyPath: expand(a.private_key) };
    }
    for (const [name, a] of Object.entries(data.google_play ?? {})) {
      out.play[name] = { serviceAccountPath: expand(a.service_account) };
    }
  }
  // The plugin options and the file may hold the same key; keep the named one.
  const named = (store, same) => Object.entries(out[store]).some(([n, a]) => n !== 'default' && same(a));
  if (out.asc.default && named('asc', (a) => a.keyId === out.asc.default.keyId)) delete out.asc.default;
  if (out.play.default) {
    const email = (path) => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')).client_email;
      } catch {
        return path;
      }
    };
    const own = email(out.play.default.serviceAccountPath);
    if (named('play', (a) => email(a.serviceAccountPath) === own)) delete out.play.default;
  }
  return out;
}

function pickAccount(all, account, store) {
  const names = Object.keys(all);
  if (!names.length) throw new StoreError(`${store} isn't set up. ${SETUP_HINT}`);
  if (account) {
    if (!all[account]) throw new StoreError(`No ${store} account named "${account}" (set up: ${names.join(', ')})`);
    return account;
  }
  if (names.length === 1) return names[0];
  throw new StoreError(`Several ${store} accounts are set up (${names.join(', ')}); pass account.`);
}

const ascClients = new Map();
const playClients = new Map();

function ascClient(name, c) {
  const missing = [!c.keyId && 'key ID', !c.issuerId && 'issuer ID', !c.keyPath && 'private key path'].filter(Boolean);
  if (missing.length) throw new StoreError(`App Store Connect account "${name}" is missing its ${missing.join(', ')}. ${SETUP_HINT}`);
  const key = JSON.stringify(c);
  if (ascClients.get(name)?.key !== key) ascClients.set(name, { key, client: new AppStoreConnect(c) });
  return ascClients.get(name).client;
}

function playClient(name, c) {
  if (!c.serviceAccountPath) throw new StoreError(`Google Play account "${name}" has no service account file. ${SETUP_HINT}`);
  if (playClients.get(name)?.key !== c.serviceAccountPath) {
    playClients.set(name, { key: c.serviceAccountPath, client: new GooglePlay(c) });
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
  for (const name of ordered(names, ascByApp.get(app))) {
    const client = asc(name);
    try {
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
    const client = play(name);
    try {
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
