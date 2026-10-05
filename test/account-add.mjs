// account_add / account_remove in a throwaway home folder.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'store-studio-home-'));
process.env.HOME = home;
for (const k of ['STORE_STUDIO_ACCOUNTS', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_PATH', 'PLAY_SERVICE_ACCOUNT_PATH']) {
  delete process.env[k];
}
const pem = (k) => k.export({ type: 'pkcs8', format: 'pem' });
mkdirSync(join(home, 'Downloads'));
const p8 = join(home, 'Downloads', 'AuthKey_TESTKEY01.p8');
writeFileSync(p8, pem(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey));
const saFile = join(home, 'Downloads', 'proj-123-abc.json');
writeFileSync(saFile, JSON.stringify({
  type: 'service_account', client_email: 'acme@p.iam.gserviceaccount.com', private_key_id: 'k',
  private_key: pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), token_uri: 'https://oauth2.googleapis.com/token',
}));

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === 'api.appstoreconnect.apple.com') {
    return json({ data: [{ id: '9', attributes: { name: 'Acme', bundleId: 'com.acme.app' } }], links: {} });
  }
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'tok', expires_in: 3600 });
  if (u.pathname.endsWith('/edits') && init.method === 'POST') return json({ id: 'E' });
  return new Response(null, { status: 204 });
};

const { accountTools } = await import('../server/account-tools.mjs');
const { accounts } = await import('../server/clients.mjs');
const run = (name, args) => accountTools.find((t) => t.name === name).run(args, { progress() {} });
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const issuer = '205642aa-f06f-4771-bcf0-c7967bdfd893';

await assert.rejects(run('account_add', { store: 'app_store', name: 'acme', key_file: p8 }), /issuer_id/);
await assert.rejects(run('account_add', { store: 'app_store', name: 'Acme Co', key_file: p8, issuer_id: issuer }), /name must/);

// App Store: the key moves out of Downloads, the Key ID comes from the name.
let r = await run('account_add', { store: 'app_store', name: 'acme', key_file: p8, issuer_id: issuer });
const moved = join(home, '.appstoreconnect', 'AuthKey_TESTKEY01.p8');
assert.equal(r.ok, true);
assert.deepEqual(r.apps, ['Acme (com.acme.app)']);
assert.equal(r.key_id, 'TESTKEY01');
assert.ok(!existsSync(p8) && existsSync(moved));
assert.equal(mode(moved), '600');
const file = join(home, '.config', 'store-studio', 'accounts.json');
assert.equal(mode(file), '600');
assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).app_store.acme, {
  key_id: 'TESTKEY01', issuer_id: issuer, private_key: '~/.appstoreconnect/AuthKey_TESTKEY01.p8',
});
assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'), 'never returns key contents');
await assert.rejects(run('account_add', { store: 'app_store', name: 'acme', key_file: moved, issuer_id: issuer }), /already/);

// A key already in a private folder stays where it is.
r = await run('account_add', { store: 'app_store', name: 'acme', key_file: moved, issuer_id: issuer, replace: true });
assert.equal(r.key_file, '~/.appstoreconnect/AuthKey_TESTKEY01.p8');

// Play: the downloaded JSON gets a fixed home and name.
r = await run('account_add', { store: 'google_play', name: 'acme', key_file: saFile, package: 'com.acme.app' });
assert.equal(r.ok, true);
assert.equal(r.service_account, 'acme@p.iam.gserviceaccount.com');
assert.equal(r.package_access, 'com.acme.app: ok');
assert.equal(r.key_file, '~/.config/store-studio/play/acme.json');
assert.equal(mode(join(home, '.config', 'store-studio', 'play', 'acme.json')), '600');

// The same key in the plugin options and the file counts once.
process.env.ASC_KEY_ID = 'TESTKEY01';
process.env.ASC_ISSUER_ID = issuer;
process.env.ASC_PRIVATE_KEY_PATH = moved;
assert.deepEqual(Object.keys(accounts().asc), ['acme']);
delete process.env.ASC_KEY_ID;

r = await run('account_remove', { store: 'app_store', name: 'acme' });
assert.equal(r.key_file_left, '~/.appstoreconnect/AuthKey_TESTKEY01.p8');
assert.ok(existsSync(moved), 'the key file stays');
assert.equal(JSON.parse(readFileSync(file, 'utf8')).app_store.acme, undefined);

console.log('account_add checks passed');
