// account_add / account_remove (connecting in the chat) in a throwaway home folder.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'store-studio-home-'));
process.env.HOME = home;
// The accounts file and key folders live under this home; no settings.
for (const k of Object.keys(process.env)) if (/^(ASC|PLAY)_/.test(k)) delete process.env[k];
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

const { accountTools } = await import('../plugin/server/account-tools.mjs');
const { accounts } = await import('../plugin/server/clients.mjs');
const run = (name, args) => accountTools.find((t) => t.name === name).run(args, { progress() {} });
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const issuer = '205642aa-f06f-4771-bcf0-c7967bdfd893';

await assert.rejects(run('account_add', { store: 'app_store', name: 'acme', key_file: p8 }), /issuer_id/);
await assert.rejects(run('account_add', { store: 'app_store', name: 'Acme Co', key_file: p8, issuer_id: issuer }), /name must/);
await assert.rejects(run('account_add', { store: 'app_store', name: 'acme', key_file: saFile, issuer_id: issuer }), /not a \.p8 file/);
await assert.rejects(run('account_add', { store: 'google_play', name: 'acme', key_file: p8 }), /not a \.json file/);

// The dry run (the default) shows the plan and touches nothing: the key file
// is not even opened, so it can't have moved and no accounts file exists.
const file = join(home, '.config', 'store-studio', 'accounts.json');
let r = await run('account_add', { store: 'app_store', name: 'acme', key_file: p8, issuer_id: issuer });
assert.deepEqual(r.plan, {
  account: 'acme', store: 'app_store', key_file: '~/Downloads/AuthKey_TESTKEY01.p8', key_id: 'TESTKEY01', issuer_id: issuer,
  move_to: '~/.appstoreconnect/AuthKey_TESTKEY01.p8', accounts_file: '~/.config/store-studio/accounts.json',
  then: 'reads the key once to check it, records its path and IDs (never its contents), and signs in to test it',
});
assert.match(r.note, /has not been opened/);
assert.ok(existsSync(p8) && !existsSync(file));

// Confirmed: the key moves out of Downloads, the Key ID comes from the name.
r = await run('account_add', { store: 'app_store', name: 'acme', key_file: p8, issuer_id: issuer, dry_run: false });
const moved = join(home, '.appstoreconnect', 'AuthKey_TESTKEY01.p8');
assert.equal(r.ok, true);
assert.deepEqual(r.apps, ['Acme (com.acme.app)']);
assert.equal(r.key_id, 'TESTKEY01');
assert.ok(!existsSync(p8) && existsSync(moved));
assert.equal(mode(moved), '600');
assert.equal(mode(file), '600');
assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).app_store.acme, {
  key_id: 'TESTKEY01', issuer_id: issuer, private_key: '~/.appstoreconnect/AuthKey_TESTKEY01.p8',
});
assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'), 'never returns key contents');
await assert.rejects(run('account_add', { store: 'app_store', name: 'acme', key_file: moved, issuer_id: issuer }), /already.*replace/);

// A key already in a private folder stays where it is.
r = await run('account_add', { store: 'app_store', name: 'acme', key_file: moved, issuer_id: issuer, replace: true, dry_run: false });
assert.equal(r.key_file, '~/.appstoreconnect/AuthKey_TESTKEY01.p8');

// Play: the downloaded JSON gets a fixed home and name.
r = await run('account_add', { store: 'google_play', name: 'acme', key_file: saFile, package: 'com.acme.app' });
assert.equal(r.plan.move_to, '~/.config/store-studio/play/acme.json');
r = await run('account_add', { store: 'google_play', name: 'acme', key_file: saFile, package: 'com.acme.app', dry_run: false });
assert.equal(r.ok, true);
assert.equal(r.service_account, 'acme@p.iam.gserviceaccount.com');
assert.equal(r.package_access, 'com.acme.app: ok');
assert.equal(r.key_file, '~/.config/store-studio/play/acme.json');
assert.equal(mode(join(home, '.config', 'store-studio', 'play', 'acme.json')), '600');

// The same key in the plugin settings and the accounts file counts once:
// under its settings name when that copy works...
const settingsKey = readFileSync(moved, 'utf8');
const withSettings = (env) => {
  Object.assign(process.env, { ASC_KEY_ID: 'TESTKEY01', ASC_ISSUER_ID: issuer, ASC_NAME: 'acme-settings', ...env });
  const listed = accounts().asc;
  for (const k of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_NAME']) delete process.env[k];
  return listed;
};
assert.deepEqual(Object.keys(withSettings({ ASC_PRIVATE_KEY: settingsKey })), ['acme-settings']);
// ...but a broken settings copy (cut to its first line, or another issuer)
// gives way to the connected key, as the settings errors advise.
let listed = withSettings({ ASC_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' });
assert.deepEqual(Object.keys(listed), ['acme']);
assert.equal(listed.acme.source, 'connected in chat');
assert.deepEqual(Object.keys(withSettings({ ASC_PRIVATE_KEY: settingsKey, ASC_ISSUER_ID: '00000000-0000-4000-8000-000000000000' })), ['acme']);

// A name already used by a settings account is refused, so tools never mix the two.
Object.assign(process.env, { ASC_KEY_ID: 'OTHERKEY1', ASC_ISSUER_ID: issuer, ASC_PRIVATE_KEY: settingsKey, ASC_NAME: 'team' });
await assert.rejects(run('account_add', { store: 'app_store', name: 'team', key_file: moved, issuer_id: issuer }), /name of an account in the plugin settings/);
for (const k of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_NAME']) delete process.env[k];

// key_id becomes part of a file name, so only letters and digits pass.
await assert.rejects(
  run('account_add', { store: 'app_store', name: 'evil', key_file: moved, issuer_id: issuer, key_id: '../../escape' }),
  /letters and digits only/,
);

// The dry run already refuses what the real run would: a different key
// waiting at the target. With replace it says what gets overwritten.
const second = join(home, 'Downloads', 'second.json');
writeFileSync(second, readFileSync(join(home, '.config', 'store-studio', 'play', 'acme.json')));
await assert.rejects(run('account_add', { store: 'google_play', name: 'acme', key_file: second }), /already/);
r = await run('account_add', { store: 'google_play', name: 'acme', key_file: second, replace: true });
assert.equal(r.plan.overwrites, '~/.config/store-studio/play/acme.json');
assert.ok(existsSync(second), 'still nothing moved');

// A key behind a link: the real file moves, not the link.
const synced = join(home, 'Synced');
mkdirSync(synced);
const real = join(synced, 'AuthKey_LINKKEY01.p8');
writeFileSync(real, settingsKey);
symlinkSync(real, join(home, 'Downloads', 'AuthKey_LINKKEY01.p8'));
r = await run('account_add', { store: 'app_store', name: 'linked', key_file: join(home, 'Downloads', 'AuthKey_LINKKEY01.p8'), issuer_id: issuer, dry_run: false });
const linkedKey = join(home, '.appstoreconnect', 'AuthKey_LINKKEY01.p8');
assert.ok(!existsSync(real) && !lstatSync(linkedKey).isSymbolicLink(), 'the key itself left the synced folder');

r = await run('account_remove', { store: 'app_store', name: 'acme' });
assert.equal(r.key_file_left, '~/.appstoreconnect/AuthKey_TESTKEY01.p8');
assert.ok(existsSync(moved), 'the key file stays');
assert.equal(JSON.parse(readFileSync(file, 'utf8')).app_store.acme, undefined);
await assert.rejects(run('account_remove', { store: 'app_store', name: 'acme' }), /connected in the chat/);

console.log('account_add checks passed');
