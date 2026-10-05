import { AppStoreConnect } from './asc.mjs';
import { GooglePlay } from './play.mjs';
import { SETTINGS_HINT, StoreError, clean } from './util.mjs';

// ---------------------------------------------------------------- accounts

export const SETUP_HINT = SETTINGS_HINT;

// The plugin settings as Claude Code passes them to this server: up to three
// accounts per store. Key contents come from the system's secure storage via
// sensitive settings; nothing is read from files.
// Each slot is [name, ...values] in the order of ASC_FIELDS / PLAY_FIELDS.
const ASC_FIELDS = ['keyId', 'issuerId', 'privateKey'];
const PLAY_FIELDS = ['serviceAccount'];

function settings() {
  const {
    ASC_NAME, ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY,
    ASC_2_NAME, ASC_2_KEY_ID, ASC_2_ISSUER_ID, ASC_2_PRIVATE_KEY,
    ASC_3_NAME, ASC_3_KEY_ID, ASC_3_ISSUER_ID, ASC_3_PRIVATE_KEY,
    PLAY_NAME, PLAY_SERVICE_ACCOUNT,
    PLAY_2_NAME, PLAY_2_SERVICE_ACCOUNT,
    PLAY_3_NAME, PLAY_3_SERVICE_ACCOUNT,
  } = process.env;
  return {
    asc: [
      [ASC_NAME, ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY],
      [ASC_2_NAME, ASC_2_KEY_ID, ASC_2_ISSUER_ID, ASC_2_PRIVATE_KEY],
      [ASC_3_NAME, ASC_3_KEY_ID, ASC_3_ISSUER_ID, ASC_3_PRIVATE_KEY],
    ],
    play: [
      [PLAY_NAME, PLAY_SERVICE_ACCOUNT],
      [PLAY_2_NAME, PLAY_2_SERVICE_ACCOUNT],
      [PLAY_3_NAME, PLAY_3_SERVICE_ACCOUNT],
    ],
  };
}

const slug = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

// Named accounts per store, from the filled-in setting slots. A slot without
// a name is called app-store / google-play (plus its number after the first).
export function accounts() {
  const out = { asc: {}, play: {} };
  const all = settings();
  for (const [store, fallback, fields] of [['asc', 'app-store', ASC_FIELDS], ['play', 'google-play', PLAY_FIELDS]]) {
    all[store].forEach(([name, ...slot], i) => {
      const values = Object.fromEntries(fields.map((field, j) => [field, clean(slot[j])]));
      if (!Object.values(values).some(Boolean)) return;
      let key = slug(clean(name)) || (i ? `${fallback}-${i + 1}` : fallback);
      if (out[store][key]) key = `${key}-${i + 1}`;
      out[store][key] = { ...values, slot: i + 1 };
    });
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
  throw new StoreError(`Several ${store} accounts are set up (${names.join(', ')}); name one in the account parameter.`);
}

const ascClients = new Map();
const playClients = new Map();

function ascClient(name, c) {
  const missing = [!c.keyId && 'key ID', !c.issuerId && 'issuer ID', !c.privateKey && 'private key'].filter(Boolean);
  if (missing.length) throw new StoreError(`App Store Connect account "${name}" is missing its ${missing.join(', ')}. ${SETUP_HINT}`);
  const fingerprint = JSON.stringify(c);
  if (ascClients.get(name)?.fingerprint !== fingerprint) ascClients.set(name, { fingerprint, client: new AppStoreConnect(c) });
  return ascClients.get(name).client;
}

function playClient(name, c) {
  if (!c.serviceAccount) throw new StoreError(`Google Play account "${name}" has no service account key. ${SETUP_HINT}`);
  const fingerprint = JSON.stringify(c);
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
