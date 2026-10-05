// End-to-end run of the push/update tools against an in-process fake of both
// store APIs. Checks JWT signatures, upload parts, checksums and edit commits.
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { makeTree } from './fixtures.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'store-studio-'));
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
// The plugin settings, as Claude Code passes them. The .p8 arrives with its
// line breaks turned into spaces, as a paste into a one-line field can do.
process.env.ASC_KEY_ID = 'KEY123';
process.env.ASC_ISSUER_ID = 'issuer-uuid';
process.env.ASC_PRIVATE_KEY = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, ' ');
process.env.PLAY_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  client_email: 'uploader@proj.iam.gserviceaccount.com',
  private_key_id: 'kid1',
  private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
}, null, 2);

// Local folders: en-US and tr iPhone, plus fr-FR (missing remotely).
const iphone = { 'iphone-6.5': [1284, 2778, 7] };
const playSets = { phone: [1080, 1920, 7], tablet: [1440, 2560, 7] };
makeTree(tmp, { ios: { 'en-US': iphone, tr: iphone, 'fr-FR': iphone }, play: { 'en-US': playSets, 'tr-TR': playSets } });

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());
function checkJwt(auth, pub, alg) {
  const [h, p, s] = auth.replace('Bearer ', '').split('.');
  const opts = alg === 'ES256' ? { key: pub, dsaEncoding: 'ieee-p1363' } : pub;
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), opts, Buffer.from(s, 'base64url')), `${alg} signature`);
  return { header: b64json(h), claims: b64json(p) };
}

// ---- fake App Store Connect
const asc = {
  sets: { 'loc-en': [{ id: 'set-en-65', type: 'APP_IPHONE_65', shots: ['old1', 'old2', 'old3'] }], 'loc-tr': [] },
  shots: {}, reorders: [], deleted: [], created: [], n: 0,
};
const log = [];
const json = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fakeAsc(url, init) {
  const u = new URL(url);
  const m = init.method ?? 'GET';
  if (u.hostname.endsWith('blobstore.apple.com')) {
    const id = u.pathname.split('/')[2];
    asc.shots[id].parts.push(Buffer.from(init.body));
    return new Response(null, { status: 200 });
  }
  const { header, claims } = checkJwt(init.headers.Authorization, ec.publicKey, 'ES256');
  assert.equal(header.kid, 'KEY123'); assert.equal(claims.iss, 'issuer-uuid'); assert.equal(claims.aud, 'appstoreconnect-v1');
  assert.ok(claims.exp - claims.iat <= 1200);
  const p = u.pathname;
  const body = init.body ? JSON.parse(init.body) : null;
  log.push(`${m} ${p}`);
  if (p === '/v1/apps' && u.searchParams.get('filter[bundleId]')) return json({ data: [{ id: '42', attributes: { name: 'Demo', bundleId: 'com.demo.app' } }] });
  // Two pages; the editable version is only on the second.
  if (p === '/v1/apps/42/appStoreVersions' && !u.searchParams.get('cursor')) return json({
    data: [{ id: 'v-live', attributes: { versionString: '1.0', appVersionState: 'READY_FOR_DISTRIBUTION', createdDate: '2026-01-01' } }],
    links: { next: 'https://api.appstoreconnect.apple.com/v1/apps/42/appStoreVersions?cursor=2' },
  });
  if (p === '/v1/apps/42/appStoreVersions') return json({ data: [
    { id: 'v-new', attributes: { versionString: '1.1', appVersionState: 'PREPARE_FOR_SUBMISSION', createdDate: '2026-09-01' } },
  ] });
  if (p === '/v1/appStoreVersions/v-live/appStoreVersionLocalizations') return json({ data: [
    { id: 'loc-live', attributes: { locale: 'en-US', promotionalText: 'Old promo' } },
  ], links: {} });
  if (p === '/v1/appStoreVersions/v-new/appStoreVersionLocalizations') return json({ data: [
    { id: 'loc-en', attributes: { locale: 'en-US', description: 'Old description', keywords: 'sleep,sounds' } },
    { id: 'loc-tr', attributes: { locale: 'tr', description: 'Eski' } },
  ], links: {} });
  let mm;
  if ((mm = p.match(/^\/v1\/appStoreVersionLocalizations\/(loc-\w+)\/appScreenshotSets$/))) {
    return json({ data: asc.sets[mm[1]].map((s) => ({ id: s.id, attributes: { screenshotDisplayType: s.type } })) });
  }
  if ((mm = p.match(/^\/v1\/appScreenshotSets\/([\w-]+)\/appScreenshots$/))) {
    const set = Object.values(asc.sets).flat().find((s) => s.id === mm[1]);
    return json({ data: set.shots.map((id) => ({ id, attributes: { fileName: `${id}.png`, assetDeliveryState: { state: 'COMPLETE' } } })) });
  }
  if (p === '/v1/appScreenshotSets' && m === 'POST') {
    const locId = body.data.relationships.appStoreVersionLocalization.data.id;
    const set = { id: `set-${locId}-${body.data.attributes.screenshotDisplayType}`, type: body.data.attributes.screenshotDisplayType, shots: [] };
    asc.sets[locId].push(set);
    return json({ data: { id: set.id, attributes: { screenshotDisplayType: set.type } } }, 201);
  }
  if (p === '/v1/appScreenshots' && m === 'POST') {
    const { fileName, fileSize } = body.data.attributes;
    const id = `shot${++asc.n}`;
    const half = Math.ceil(fileSize / 2);
    asc.shots[id] = { fileName, fileSize, parts: [], set: body.data.relationships.appScreenshotSet.data.id };
    return json({ data: { id, attributes: { uploadOperations: [
      { method: 'PUT', url: `https://store-001.blobstore.apple.com/up/${id}/a`, offset: 0, length: half, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
      { method: 'PUT', url: `https://store-001.blobstore.apple.com/up/${id}/b`, offset: half, length: fileSize - half, requestHeaders: [] },
    ] } } }, 201);
  }
  if ((mm = p.match(/^\/v1\/appScreenshots\/(shot\d+)$/))) {
    const s = asc.shots[mm[1]];
    if (m === 'PATCH') {
      const all = Buffer.concat(s.parts);
      assert.equal(all.length, s.fileSize, 'all parts uploaded');
      assert.equal(body.data.attributes.sourceFileChecksum, createHash('md5').update(all).digest('hex'), 'md5');
      s.committed = true;
      Object.values(asc.sets).flat().find((x) => x.id === s.set).shots.push(mm[1]);
      return json({ data: { id: mm[1], attributes: {} } });
    }
    return json({ data: { id: mm[1], attributes: { fileName: s.fileName, assetDeliveryState: { state: 'COMPLETE' } } } });
  }
  if ((mm = p.match(/^\/v1\/appScreenshots\/(old\d)$/)) && m === 'DELETE') {
    asc.deleted.push(mm[1]);
    for (const s of Object.values(asc.sets).flat()) s.shots = s.shots.filter((x) => x !== mm[1]);
    return new Response(null, { status: 204 });
  }
  if ((mm = p.match(/^\/v1\/appScreenshotSets\/([\w-]+)\/relationships\/appScreenshots$/)) && m === 'PATCH') {
    asc.reorders.push({ set: mm[1], ids: body.data.map((d) => d.id) });
    return new Response(null, { status: 204 });
  }
  if ((mm = p.match(/^\/v1\/appStoreVersionLocalizations\/(loc-\w+)$/)) && m === 'PATCH') {
    asc.patched = { id: mm[1], attributes: body.data.attributes };
    return json({ data: { id: mm[1], attributes: body.data.attributes } });
  }
  return json({ errors: [{ title: 'Not found', detail: `${m} ${p}` }] }, 404);
}

// ---- fake Google Play
const play = { edits: {}, n: 0, tokenCalls: 0 };
async function fakePlay(url, init) {
  const u = new URL(url);
  const m = init.method ?? 'GET';
  if (u.hostname === 'oauth2.googleapis.com') {
    play.tokenCalls++;
    const assertion = new URLSearchParams(init.body.toString()).get('assertion');
    const { header, claims } = checkJwt(assertion, rsa.publicKey, 'RS256');
    assert.equal(header.kid, 'kid1'); assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher');
    return json({ access_token: 'ya29.test', expires_in: 3600 });
  }
  assert.equal(init.headers.Authorization, 'Bearer ya29.test');
  const p = u.pathname.replace(/^\/(upload\/)?androidpublisher\/v3\/applications\/com\.demo\.app/, '');
  log.push(`${m} ${u.pathname.startsWith('/upload') ? 'UPLOAD ' : ''}${p}${u.search}`);
  if (p === '/edits' && m === 'POST') {
    const id = `e${++play.n}`;
    play.edits[id] = { images: { 'en-US': { phoneScreenshots: ['a', 'b'] }, 'tr-TR': {} }, uploads: [] };
    return json({ id });
  }
  let mm = p.match(/^\/edits\/(e\d+)(.*)$/);
  const e = play.edits[mm[1]];
  const rest = mm[2];
  if (rest === ':commit') { e.committed = u.search; return json({ id: mm[1] }); }
  if (rest === ':validate') { e.validated = true; return json({ id: mm[1] }); }
  if (rest === '/tracks' && m === 'GET') return json({ tracks: [{ track: 'production', releases: [{ name: '49 (1.1.0)', versionCodes: ['49'], status: 'completed' }] }] });
  if (rest === '/bundles' && m === 'POST') {
    assert.ok(u.pathname.startsWith('/upload/') && u.searchParams.get('uploadType') === 'media');
    assert.equal(init.headers['Content-Type'], 'application/octet-stream');
    e.bundle = init.body.length;
    return json({ versionCode: 53, sha1: 'x', sha256: 'y' });
  }
  if (rest === '/tracks/production' && m === 'PUT') { e.track = JSON.parse(init.body); return json(e.track); }
  if (rest === '' && m === 'DELETE') { e.deleted = true; return new Response(null, { status: 204 }); }
  if (rest === '/listings') return json({ listings: [
    { language: 'en-US', title: 'Demo', shortDescription: 'Short', fullDescription: 'Full' },
    { language: 'tr-TR', title: 'Demo', shortDescription: 'Kısa', fullDescription: 'Uzun' },
  ] });
  if ((mm = rest.match(/^\/listings\/([\w-]+)\/(\w+)$/))) {
    const [, lang, type] = mm;
    const imgs = (e.images[lang] ??= {});
    if (m === 'GET') return json(imgs[type]?.length ? { images: imgs[type].map((id) => ({ id, url: `https://play-lh.googleusercontent.com/${id}` })) } : {});
    if (m === 'DELETE') { imgs[type] = []; return json({ deleted: [] }); }
    if (m === 'POST') {
      assert.ok(u.pathname.startsWith('/upload/'), 'upload host path'); assert.equal(u.searchParams.get('uploadType'), 'media');
      assert.equal(init.headers['Content-Type'], 'image/png');
      (imgs[type] ??= []).push(`n${e.uploads.length}`); e.uploads.push(`${lang}/${type}/${init.body.length}`);
      return json({ image: { id: `n${e.uploads.length}` } });
    }
  }
  if ((mm = rest.match(/^\/listings\/([\w-]+)$/))) {
    if (m === 'GET') return json({ language: mm[1], title: 'Demo', shortDescription: 'Short', fullDescription: 'Full' });
    if (m === 'PUT') { e.put = JSON.parse(init.body); return json(e.put); }
  }
  return json({ error: { message: `unhandled ${m} ${p}` } }, 404);
}

globalThis.fetch = async (url, init = {}) => {
  const host = new URL(url).hostname;
  if (host.endsWith('apple.com')) return fakeAsc(url, init);
  return fakePlay(url, init);
};

const { tools } = await import('../plugin/server/tools.mjs');
const run = async (name, args) => {
  const events = [];
  const out = await tools.find((t) => t.name === name).run(args, { progress: (msg) => events.push(msg) });
  return { out, events };
};

// App Store: dry run touches nothing.
let r = await run('asc_screenshots_push', { app: 'com.demo.app', dir: join(tmp, 'ios') });
console.log('asc dry run plan:', JSON.stringify(r.out.plan));
assert.equal(asc.n, 0); assert.equal(asc.deleted.length, 0);
assert.match(r.out.note, /Dry run/);
assert.ok(r.out.plan.find((x) => x.locale === 'fr-FR').skipped);

// App Store: apply.
r = await run('asc_screenshots_push', { app: 'com.demo.app', dir: join(tmp, 'ios'), dry_run: false });
console.log('asc apply:', JSON.stringify(r.out.result));
assert.deepEqual(asc.deleted.sort(), ['old1', 'old2', 'old3']);
assert.equal(asc.n, 14);
assert.ok(Object.values(asc.shots).every((s) => s.committed));
assert.equal(asc.reorders.length, 2);
for (const ro of asc.reorders) {
  const names = ro.ids.map((id) => asc.shots[id].fileName);
  assert.deepEqual(names, [...names].sort(), 'reorder follows file order');
}
assert.equal(asc.sets['loc-tr'][0].type, 'APP_IPHONE_65', 'set created for tr');

// App Store text: over-limit rejected, dry run shows diff, apply patches.
await assert.rejects(run('asc_metadata_update', { app: 'com.demo.app', changes: [{ locale: 'en-US', keywords: 'x'.repeat(101) }] }), /limits/);
r = await run('asc_metadata_update', { app: 'com.demo.app', changes: [{ locale: 'en-US', description: 'New description', keywords: 'sleep,sounds' }] });
console.log('asc text dry run:', JSON.stringify(r.out.plan));
assert.equal(r.out.plan[0].changes.length, 1, 'unchanged keywords skipped');
assert.equal(asc.patched, undefined);
await run('asc_metadata_update', { app: 'com.demo.app', changes: [{ locale: 'en-US', description: 'New description' }], dry_run: false });
assert.deepEqual(asc.patched, { id: 'loc-en', attributes: { description: 'New description' } });
// Promotional text on its own changes the live version, not the one being prepared.
const promo = { app: 'com.demo.app', changes: [{ locale: 'en-US', promotional_text: 'Autumn sale' }] };
r = await run('asc_metadata_update', promo);
assert.match(r.out.version, /^1\.0 READY_FOR_DISTRIBUTION \(live/);
await run('asc_metadata_update', { ...promo, dry_run: false });
assert.deepEqual(asc.patched, { id: 'loc-live', attributes: { promotionalText: 'Autumn sale' } });
r = await run('asc_metadata_update', { app: 'com.demo.app', changes: [{ locale: 'en-US', promotional_text: 'Autumn sale', description: 'Newer' }] });
assert.match(r.out.version, /^1\.1 PREPARE_FOR_SUBMISSION$/, 'with other version text it stays on the prepared version');

// Play: dry run opens and deletes an edit.
r = await run('play_screenshots_push', { package: 'com.demo.app', dir: join(tmp, 'play') });
console.log('play dry run plan:', JSON.stringify(r.out.plan));
assert.ok(play.edits.e1.deleted && !play.edits.e1.committed);
// Play: apply commits once, not sent for review by default.
r = await run('play_screenshots_push', { package: 'com.demo.app', dir: join(tmp, 'play'), dry_run: false });
const e2 = play.edits.e2;
console.log('play apply uploads:', e2.uploads.length, 'commit query:', e2.committed);
assert.equal(e2.committed, '?changesNotSentForReview=true');
assert.equal(e2.uploads.length, 28);
assert.ok(!e2.deleted);
// Play text.
r = await run('play_listing_update', { package: 'com.demo.app', changes: [{ language: 'en-US', short_description: 'Better sleep, every night' }], dry_run: false, send_for_review: true });
assert.equal(play.edits.e3.committed, '');
assert.equal(play.edits.e3.put.shortDescription, 'Better sleep, every night');
assert.equal(play.edits.e3.put.title, 'Demo', 'other fields kept');
await assert.rejects(run('play_listing_update', { package: 'com.demo.app', changes: [{ language: 'en-US', short_description: 'y'.repeat(81) }] }), /limits/);
assert.equal(play.tokenCalls, 1, 'token cached');

// Play bundle: a dry run uploads and validates in a thrown-away edit; a real
// run puts a staged release on the track and commits.
const aab = join(tmp, 'app-release.aab');
writeFileSync(aab, Buffer.alloc(2048, 7));
const notes = [{ language: 'en-US', text: 'Bug fixes.' }];
r = await run('play_bundle_upload', { package: 'com.demo.app', aab, track: 'production', rollout: 0.2, release_notes: notes });
let eb = play.edits[`e${play.n}`];
assert.ok(eb.validated && eb.deleted && !eb.committed, 'dry run validates, then throws the edit away');
assert.equal(eb.bundle, 2048);
assert.deepEqual(r.out.on_track_now, ['49 (1.1.0) completed']);
assert.match(r.out.note, /Dry run/);
r = await run('play_bundle_upload', { package: 'com.demo.app', aab, track: 'production', rollout: 0.2, release_notes: notes, dry_run: false, send_for_review: true });
eb = play.edits[`e${play.n}`];
assert.equal(eb.committed, '');
assert.deepEqual(eb.track.releases, [{ versionCodes: ['53'], status: 'inProgress', userFraction: 0.2, releaseNotes: notes }]);
await assert.rejects(run('play_bundle_upload', { package: 'com.demo.app', aab, release_notes: [{ language: 'en-US', text: 'x'.repeat(501) }] }), /Play limit/);
await assert.rejects(run('play_bundle_upload', { package: 'com.demo.app', aab: 'relative.aab' }), /absolute/);

console.log('\nall mock checks passed;', log.length, 'API calls');
