// Several accounts from the plugin settings' slots, each seeing different apps.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

const pem = (k) => k.export({ type: 'pkcs8', format: 'pem' });
const key = () => pem(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);
const sa = (email) =>
  JSON.stringify({
    type: 'service_account', client_email: email, private_key_id: email,
    private_key: pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), token_uri: 'https://oauth2.googleapis.com/token',
  });

// Slot 1 unnamed; slot 2 named; slot 3 left as Claude Code passes unset settings.
Object.assign(process.env, {
  ASC_KEY_ID: 'KDEFAULT', ASC_ISSUER_ID: 'issuer-default', ASC_PRIVATE_KEY: key(), ASC_NAME: '',
  ASC_2_KEY_ID: 'KAPPIK', ASC_2_ISSUER_ID: 'issuer-appik', ASC_2_PRIVATE_KEY: key(), ASC_2_NAME: ' Appik ',
  ASC_3_KEY_ID: '${user_config.app_store_3_key_id}', ASC_3_PRIVATE_KEY: '',
  PLAY_SERVICE_ACCOUNT: sa('default@p.iam.gserviceaccount.com'),
  PLAY_2_SERVICE_ACCOUNT: sa('appik@p.iam.gserviceaccount.com'), PLAY_2_NAME: 'appik',
});

// Each ASC key sees its own app; each Play account opens only its own package.
const APPS = {
  KDEFAULT: [{ id: '111', attributes: { name: 'Demo', bundleId: 'com.demo.app' } }],
  KAPPIK: [{ id: '222', attributes: { name: 'Other', bundleId: 'com.other.app' } }],
};
const PLAY = { 'tok-default@p.iam.gserviceaccount.com': 'com.demo.app', 'tok-appik@p.iam.gserviceaccount.com': 'com.other.app' };
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

assert.deepEqual(Object.keys(accounts().asc), ['app-store', 'appik']);
assert.deepEqual(Object.keys(accounts().play), ['google-play', 'appik']);
assert.throws(() => asc(), /Several App Store Connect accounts/);

// setup_check and asc_apps cover every account.
let r = await run('setup_check', { package: 'com.other.app' });
assert.deepEqual(r.app_store['app-store'].apps, ['Demo (com.demo.app)']);
assert.deepEqual(r.app_store.appik.apps, ['Other (com.other.app)']);
assert.equal(r.google_play['google-play'].ok, false, 'slot 1 has no access to com.other.app');
assert.equal(r.google_play.appik.package_access, 'com.other.app: ok');
r = await run('asc_apps');
assert.deepEqual(r.map((a) => `${a.account}:${a.bundle_id}`), ['app-store:com.demo.app', 'appik:com.other.app']);

// App tools find the right account by bundle id, then remember it.
calls.length = 0;
const { ascForApp, playForPackage } = await import('../plugin/server/clients.mjs');
r = await ascForApp('com.other.app');
assert.equal(r.account, 'appik');
assert.deepEqual(calls, ['asc KDEFAULT /v1/apps', 'asc KAPPIK /v1/apps'], 'tries slot 1, then appik');
calls.length = 0;
await ascForApp('com.other.app');
assert.deepEqual(calls, ['asc KAPPIK /v1/apps'], 'remembered account goes first');
await assert.rejects(ascForApp('com.nobody.app'), /None of the App Store Connect accounts/);
assert.equal((await ascForApp('com.demo.app', 'app-store')).account, 'app-store');
await assert.rejects(ascForApp('com.demo.app', 'nope'), /No App Store Connect account named "nope"/);

// Play: the package picks the service account.
r = await playForPackage('com.other.app');
assert.equal(r.account, 'appik');
r = await run('play_listing_get', { package: 'com.other.app' });
assert.equal(r.listings[0].title, 'com.other.app');

// Generic tools: the app in the path picks the account; otherwise ask.
r = await run('asc_api_get', { path: '/v1/apps/222/customerReviews' });
assert.equal(r.data[0].id, 'r1');
await assert.rejects(run('asc_api_get', { path: '/v1/salesReports' }), /pass account/);
r = await run('play_api_get', { path: 'applications/com.other.app/edits/x/listings' }).catch((e) => e);
assert.ok(!/pass account/.test(String(r)), 'package in the path picks the Play account');

// setup_check shows slots and key IDs, never key contents.
r = await run('setup_check', { live: false });
assert.deepEqual(r.app_store.appik, { slot: 2, key_id: 'KAPPIK' });
assert.equal(r.google_play.appik.service_account, 'appik@p.iam.gserviceaccount.com');
assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'));

// Settings mistakes get plain errors that never quote the value.
const { AppStoreConnect } = await import('../plugin/server/asc.mjs');
const { GooglePlay } = await import('../plugin/server/play.mjs');
await assert.rejects(new AppStoreConnect({ keyId: 'K', privateKey: '~/.appstoreconnect/AuthKey_K.p8' }).token(), /holds a file path/);
await assert.rejects(new AppStoreConnect({ keyId: 'K', privateKey: 'key: {oops}' }).token(), /isn't a private key/);
await assert.rejects(new AppStoreConnect({ keyId: 'K', privateKey: 'not a key at all' }).token(), /isn't a valid \.p8 key/);
let err = await new GooglePlay({ serviceAccount: '{"type": "service_account", "private_key": "SECRET' }).account().catch((e) => e);
assert.match(err.message, /isn't valid JSON/);
assert.ok(!err.message.includes('SECRET'));
await assert.rejects(new GooglePlay({ serviceAccount: '/Users/me/key.json' }).account(), /holds a file path/);
await assert.rejects(new GooglePlay({ serviceAccount: '{"type": "authorized_user"}' }).account(), /isn't a service account key/);
// The private key with literal \n, as copied out of the JSON, still works.
const flat = JSON.parse(sa('flat@p.iam.gserviceaccount.com')).private_key.replace(/\n/g, '\\n');
assert.ok((await new GooglePlay({ serviceAccount: JSON.stringify({ type: 'service_account', client_email: 'f@x', private_key: flat }) }).account()).private_key.includes('\n'));
// A slot with a missing field says which one.
process.env.ASC_3_KEY_ID = 'K3';
assert.throws(() => asc('app-store-3'), /"app-store-3" is missing its issuer ID, private key/);

console.log('account checks passed');
