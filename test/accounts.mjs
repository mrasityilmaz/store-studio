// Several accounts: the default one from the plugin options plus a second
// one from the accounts file, each seeing different apps.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'store-studio-accounts-'));
const pem = (k) => k.export({ type: 'pkcs8', format: 'pem' });
const key = (file) => {
  writeFileSync(join(tmp, file), pem(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey));
  return join(tmp, file);
};
const sa = (file, email) => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(join(tmp, file), JSON.stringify({ type: 'service_account', client_email: email, private_key_id: email, private_key: pem(rsa.privateKey), token_uri: 'https://oauth2.googleapis.com/token' }));
  return join(tmp, file);
};

Object.assign(process.env, {
  ASC_KEY_ID: 'KDEFAULT', ASC_ISSUER_ID: 'issuer-default', ASC_PRIVATE_KEY_PATH: key('default.p8'),
  PLAY_SERVICE_ACCOUNT_PATH: sa('default.json', 'default@p.iam.gserviceaccount.com'),
  STORE_STUDIO_ACCOUNTS: join(tmp, 'accounts.json'),
});
writeFileSync(join(tmp, 'accounts.json'), JSON.stringify({
  app_store: { appik: { key_id: 'KAPPIK', issuer_id: 'issuer-appik', private_key: key('appik.p8') } },
  google_play: { appik: { service_account: sa('appik.json', 'appik@p.iam.gserviceaccount.com') } },
}));

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

const { tools } = await import('../server/tools.mjs');
const { apiTools } = await import('../server/api-tools.mjs');
const { asc, accounts } = await import('../server/clients.mjs');
const run = (name, args = {}) => [...tools, ...apiTools].find((t) => t.name === name).run(args, { progress() {} });

assert.deepEqual(Object.keys(accounts().asc), ['default', 'appik']);
assert.throws(() => asc(), /Several App Store Connect accounts/);

// setup_check and asc_apps cover every account.
let r = await run('setup_check', { package: 'com.other.app' });
assert.deepEqual(r.app_store.default.apps, ['Demo (com.demo.app)']);
assert.deepEqual(r.app_store.appik.apps, ['Other (com.other.app)']);
assert.equal(r.google_play.default.ok, false, 'default SA has no access to com.other.app');
assert.equal(r.google_play.appik.package_access, 'com.other.app: ok');
r = await run('asc_apps');
assert.deepEqual(r.map((a) => `${a.account}:${a.bundle_id}`), ['default:com.demo.app', 'appik:com.other.app']);

// App tools find the right account by bundle id, then remember it.
calls.length = 0;
const { ascForApp, playForPackage } = await import('../server/clients.mjs');
r = await ascForApp('com.other.app');
assert.equal(r.account, 'appik');
assert.deepEqual(calls, ['asc KDEFAULT /v1/apps', 'asc KAPPIK /v1/apps'], 'tries default, then appik');
calls.length = 0;
await ascForApp('com.other.app');
assert.deepEqual(calls, ['asc KAPPIK /v1/apps'], 'remembered account goes first');
await assert.rejects(ascForApp('com.nobody.app'), /None of the App Store Connect accounts/);
assert.equal((await ascForApp('com.demo.app', 'default')).account, 'default');
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

// A broken accounts file is reported, not ignored.
writeFileSync(join(tmp, 'accounts.json'), '{ nope');
assert.throws(() => accounts(), /Can't read the accounts file/);

console.log('account checks passed');
