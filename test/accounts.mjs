// Several accounts, from the plugin settings' two slots and from the accounts
// file (connected in the chat), each seeing different apps.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pem = (k) => k.export({ type: 'pkcs8', format: 'pem' });
const key = () => pem(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);
const sa = (email) =>
  JSON.stringify({
    type: 'service_account', client_email: email, private_key_id: email,
    private_key: pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), token_uri: 'https://oauth2.googleapis.com/token',
  });

// Settings: slot 1 unnamed, slot 2 named; an unset option arrives as the
// literal placeholder.
const defaultSa = sa('default@p.iam.gserviceaccount.com');
Object.assign(process.env, {
  ASC_KEY_ID: 'KDEFAULT', ASC_ISSUER_ID: 'issuer-default', ASC_PRIVATE_KEY: key(), ASC_NAME: '${user_config.app_store_name}',
  ASC_2_KEY_ID: 'KAPPIK', ASC_2_ISSUER_ID: 'issuer-appik', ASC_2_PRIVATE_KEY: key(), ASC_2_NAME: ' Appik ',
  PLAY_SERVICE_ACCOUNT: defaultSa,
  PLAY_2_SERVICE_ACCOUNT: sa('appik@p.iam.gserviceaccount.com'), PLAY_2_NAME: 'appik',
});

// Connected in the chat: one key that is also in the settings (listed once),
// a third team, one without its issuer ID; the same for Play.
const tmp = mkdtempSync(join(tmpdir(), 'store-studio-accounts-'));
const file = (name, text) => (writeFileSync(join(tmp, name), text), join(tmp, name));
// A throwaway home holds the accounts file.
process.env.HOME = tmp;
mkdirSync(join(tmp, '.config', 'store-studio'), { recursive: true });
writeFileSync(join(tmp, '.config', 'store-studio', 'accounts.json'), JSON.stringify({
  app_store: {
    dup: { key_id: 'KDEFAULT', issuer_id: 'issuer-default', private_key: file('AuthKey_KDEFAULT.p8', key()) },
    team3: { key_id: 'KFILE', issuer_id: 'issuer-file', private_key: file('AuthKey_KFILE.p8', key()) },
    broken: { key_id: 'KBROKEN', private_key: file('AuthKey_KBROKEN.p8', key()) },
  },
  google_play: {
    dup: { service_account: file('default.json', defaultSa) },
    studio: { service_account: file('studio.json', sa('studio@p.iam.gserviceaccount.com')) },
  },
}));

// Each ASC key sees its own app; each Play account opens only its own package.
const APPS = {
  KDEFAULT: [{ id: '111', attributes: { name: 'Demo', bundleId: 'com.demo.app' } }],
  KAPPIK: [{ id: '222', attributes: { name: 'Other', bundleId: 'com.other.app' } }],
  KFILE: [{ id: '333', attributes: { name: 'File app', bundleId: 'com.file.app' } }],
};
const PLAY = {
  'tok-default@p.iam.gserviceaccount.com': 'com.demo.app',
  'tok-appik@p.iam.gserviceaccount.com': 'com.other.app',
  'tok-studio@p.iam.gserviceaccount.com': 'com.studio.app',
};
const calls = [];
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const m = init.method ?? 'GET';
  if (u.hostname === 'api.appstoreconnect.apple.com') {
    const kid = JSON.parse(Buffer.from(init.headers.Authorization.split(' ')[1].split('.')[0], 'base64url')).kid;
    calls.push(`asc ${kid} ${u.pathname}`);
    const apps = APPS[kid];
    if (u.pathname === '/v1/apps') {
      const bundle = u.searchParams.get('filter[bundleId]');
      return json({ data: bundle ? apps.filter((a) => a.attributes.bundleId === bundle) : apps, links: {} });
    }
    const id = u.pathname.match(/^\/v1\/apps\/(\d+)/)?.[1];
    if (id) {
      const app = apps.find((a) => a.id === id);
      if (!app) return json({ errors: [{ title: 'Not found' }] }, 404);
      if (u.pathname === `/v1/apps/${id}`) return json({ data: app });
      return json({ data: [{ id: 'r1', type: 'customerReviews' }], links: {} });
    }
  }
  if (u.hostname === 'oauth2.googleapis.com') {
    const assertion = new URLSearchParams(init.body.toString()).get('assertion');
    const iss = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url')).iss;
    return json({ access_token: `tok-${iss}`, expires_in: 3600 });
  }
  if (u.hostname === 'androidpublisher.googleapis.com') {
    const token = init.headers.Authorization.split(' ')[1];
    const pkg = u.pathname.match(/applications\/([^/]+)/)?.[1];
    calls.push(`play ${token} ${m} ${u.pathname}`);
    if (PLAY[token] !== pkg) return json({ error: { message: 'The caller does not have permission' } }, 403);
    if (u.pathname.endsWith('/edits') && m === 'POST') return json({ id: 'E1' });
    if (m === 'DELETE') return new Response(null, { status: 204 });
    if (u.pathname.endsWith('/listings')) return json({ listings: [{ language: 'en-US', title: pkg }] });
  }
  return json({ errors: [{ title: 'unexpected', detail: `${m} ${url}` }] }, 404);
};

const { tools } = await import('../plugin/server/tools.mjs');
const { apiTools } = await import('../plugin/server/api-tools.mjs');
const { asc, accounts } = await import('../plugin/server/clients.mjs');
const run = (name, args = {}) => [...tools, ...apiTools].find((t) => t.name === name).run(args, { progress() {} });

assert.deepEqual(Object.keys(accounts().asc), ['app-store', 'appik', 'team3', 'broken']);
assert.deepEqual(Object.keys(accounts().play), ['google-play', 'appik', 'studio']);
assert.equal(accounts().asc.team3.source, 'connected in chat');
assert.equal(accounts().asc.appik.source, 'settings slot 2');
assert.throws(() => asc(), /Several App Store Connect accounts/);

// setup_check and asc_apps cover every account.
let r = await run('setup_check', { package: 'com.other.app' });
assert.deepEqual(r.app_store['app-store'].apps, ['Demo (com.demo.app)']);
assert.deepEqual(r.app_store.appik.apps, ['Other (com.other.app)']);
assert.equal(r.google_play['google-play'].ok, false, 'slot 1 has no access to com.other.app');
assert.equal(r.google_play.appik.package_access, 'com.other.app: ok');
assert.deepEqual(r.app_store.team3.apps, ['File app (com.file.app)'], 'a key read from its file signs in');
assert.equal(r.app_store.broken.ok, false);
assert.match(r.app_store.broken.error, /"broken" is missing its issuer ID/);
r = await run('asc_apps');
assert.deepEqual(r.filter((a) => a.bundle_id).map((a) => `${a.account}:${a.bundle_id}`), ['app-store:com.demo.app', 'appik:com.other.app', 'team3:com.file.app']);
assert.match(r.find((a) => a.account === 'broken').error, /missing its issuer ID/, 'a broken account is a row, not a failure');

// App tools find the right account by bundle id, then remember it.
calls.length = 0;
const { ascForApp, playForPackage } = await import('../plugin/server/clients.mjs');
r = await ascForApp('com.other.app');
assert.equal(r.account, 'appik');
assert.deepEqual(calls, ['asc KDEFAULT /v1/apps', 'asc KAPPIK /v1/apps'], 'tries slot 1, then appik');
assert.equal((await ascForApp('com.file.app')).account, 'team3');
calls.length = 0;
await ascForApp('com.other.app');
assert.deepEqual(calls, ['asc KAPPIK /v1/apps'], 'remembered account goes first');
await assert.rejects(ascForApp('com.nobody.app'), /None of the App Store Connect accounts/);
assert.equal((await ascForApp('com.demo.app', 'app-store')).account, 'app-store');
await assert.rejects(ascForApp('com.demo.app', 'nope'), /No App Store Connect account named "nope"/);

// Play: the package picks the service account.
r = await playForPackage('com.other.app');
assert.equal(r.account, 'appik');
assert.equal((await playForPackage('com.studio.app')).account, 'studio');
r = await run('play_listing_get', { package: 'com.other.app' });
assert.equal(r.listings[0].title, 'com.other.app');

// Generic tools: the app in the path picks the account; otherwise ask.
r = await run('asc_api_get', { path: '/v1/apps/222/customerReviews' });
assert.equal(r.data[0].id, 'r1');
await assert.rejects(run('asc_api_get', { path: '/v1/salesReports' }), /account parameter/);
r = await run('play_api_get', { path: 'applications/com.other.app/edits/x/listings' }).catch((e) => e);
assert.ok(!/account parameter/.test(String(r)), 'package in the path picks the Play account');

// setup_check shows where each account comes from and its key ID or key
// file path, never key contents.
r = await run('setup_check', { live: false });
assert.deepEqual(r.app_store.appik, { source: 'settings slot 2', key_id: 'KAPPIK' });
assert.deepEqual(r.app_store.team3, { source: 'connected in chat', key_id: 'KFILE', key_file: join(tmp, 'AuthKey_KFILE.p8') });
assert.equal(r.google_play.appik.service_account, 'appik@p.iam.gserviceaccount.com');
assert.equal(r.google_play.studio.service_account, 'studio@p.iam.gserviceaccount.com');
assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'));

// Settings mistakes get plain errors that never quote the value.
const { AppStoreConnect } = await import('../plugin/server/asc.mjs');
const { GooglePlay } = await import('../plugin/server/play.mjs');
await assert.rejects(new AppStoreConnect({ keyId: 'K', privateKey: '~/.appstoreconnect/AuthKey_K.p8' }).token(), /holds a file path, not a key/);
// The terminal settings form keeps only the first line of a pasted key.
await assert.rejects(new AppStoreConnect({ keyId: 'K', privateKey: '-----BEGIN PRIVATE KEY-----' }).token(), /only its first line was saved/);
await assert.rejects(new GooglePlay({ serviceAccount: '{' }).account(), /only its first line was saved/);
// A connected account whose key file is gone says how to reconnect.
await assert.rejects(new AppStoreConnect({ keyId: 'K', issuerId: 'I', keyPath: join(tmp, 'gone.p8') }).token(), /Can't read the App Store Connect key file .*account_add/);
await assert.rejects(new GooglePlay({ serviceAccountPath: join(tmp, 'gone.json') }).account(), /Can't read the Google Play service account file .*account_add/);
await assert.rejects(new AppStoreConnect({ keyId: 'K', privateKey: 'key: {oops}' }).token(), /isn't a private key/);
await assert.rejects(new AppStoreConnect({ keyId: 'K', privateKey: 'not a key at all' }).token(), /isn't a valid \.p8 key/);
let err = await new GooglePlay({ serviceAccount: '{"type": "service_account", "private_key": "SECRET' }).account().catch((e) => e);
assert.match(err.message, /isn't valid JSON/);
assert.ok(!err.message.includes('SECRET'));
await assert.rejects(new GooglePlay({ serviceAccount: '/Users/me/key.json' }).account(), /holds a file path, not the key/);
await assert.rejects(new GooglePlay({ serviceAccount: '{"type": "authorized_user"}' }).account(), /isn't a Google service account key/);
// The private key with literal \n, as copied out of the JSON, still works.
const flat = JSON.parse(sa('flat@p.iam.gserviceaccount.com')).private_key.replace(/\n/g, '\\n');
assert.ok((await new GooglePlay({ serviceAccount: JSON.stringify({ type: 'service_account', client_email: 'f@x', private_key: flat }) }).account()).private_key.includes('\n'));
// An account with a missing field says which one.
assert.throws(() => asc('broken'), /"broken" is missing its issuer ID/);

// A key file replaced under the same path (account_add with replace) is used
// at once, not an older cached client.
const { play } = await import('../plugin/server/clients.mjs');
const cached = play('studio');
writeFileSync(join(tmp, 'studio.json'), sa('studio2@p.iam.gserviceaccount.com'));
utimesSync(join(tmp, 'studio.json'), new Date(), new Date(Date.now() + 5000));
assert.notEqual(play('studio'), cached);
assert.equal((await play('studio').account()).client_email, 'studio2@p.iam.gserviceaccount.com');

// With nothing set up, the hint offers connecting in the chat first. Loaded
// from a local folder (data folder ends in -inline), Claude Code gives the
// plugin none of its saved settings, so the hint says so instead.
const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ASC|PLAY)_/.test(k)));
for (const k of Object.keys(saved)) delete process.env[k];
process.env.HOME = mkdtempSync(join(tmpdir(), 'store-studio-empty-'));
const data = process.env.STORE_STUDIO_DATA;
process.env.STORE_STUDIO_DATA = '/tmp/claude/plugins/data/store-studio-inline';
r = await run('setup_check', { live: false });
assert.match(r.hint, /^Connect it in the chat.*loaded from a local folder/s);
await assert.rejects(run('asc_api_get', { path: '/v1/salesReports' }), /isn't set up\. Connect it in the chat.*loaded from a local folder/s);
process.env.STORE_STUDIO_DATA = '/tmp/claude/plugins/data/store-studio-store-studio';
r = await run('setup_check', { live: false });
assert.match(r.hint, /Connect it in the chat.*Configure options/s);
assert.ok(!/local folder/.test(r.hint), 'no folder note for a normal install');
process.env.STORE_STUDIO_DATA = data;
process.env.HOME = tmp;
Object.assign(process.env, saved);

console.log('account checks passed');
