// Generic API tools against small reference fixtures and fake store APIs.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const tmp = mkdtempSync(join(tmpdir(), 'store-studio-api-'));
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const p8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const saJson = JSON.stringify({
  type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com', private_key_id: 'k',
  private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token',
});
// Key files on disk only to check they are refused as bodies and save targets.
writeFileSync(join(tmp, 'key.p8'), p8);
writeFileSync(join(tmp, 'sa.json'), saJson);
// The plugin settings, as Claude Code passes them.
Object.assign(process.env, {
  ASC_KEY_ID: 'K2', ASC_ISSUER_ID: 'I2', ASC_PRIVATE_KEY: p8, PLAY_SERVICE_ACCOUNT: saJson,
  STORE_STUDIO_DATA: join(tmp, 'data'),
});

// Reference fixtures in the cache, so no network is needed.
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const ok = { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } };
const noContent = { 204: { description: 'Success (no content)' } };
const linkage = (type) => ({
  type: 'object',
  required: ['data'],
  properties: { data: { type: 'array', items: { type: 'object', required: ['id', 'type'], properties: { type: { type: 'string', enum: [type] }, id: { type: 'string' } } } } },
});
const links = (name) => body({ $ref: `#/components/schemas/${name}` });
const listParam = (name, values) => ({ name, in: 'query', schema: { type: 'array', items: { type: 'string', enum: values } } });
mkdirSync(join(tmp, 'data/reference'), { recursive: true });
writeFileSync(join(tmp, 'data/reference/asc-openapi.json'), JSON.stringify({
  info: { version: 'test' },
  components: {
    schemas: {
      BetaGroupBuildsLinkagesRequest: linkage('builds'),
      BuildBetaGroupsLinkagesRequest: linkage('betaGroups'),
      AppScreenshotSetAppScreenshotsLinkagesRequest: linkage('appScreenshots'),
    },
    parameters: { limitBetaGroups: { name: 'limit[betaGroups]', in: 'query', schema: { type: 'integer', maximum: 50 } } },
  },
  paths: {
    // To-many relationships: one with its own read, one readable only through
    // the parent's include, and a replace.
    '/v1/betaGroups/{id}/relationships/builds': {
      get: { operationId: 'betaGroups_builds_getToManyRelationship', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }], responses: ok },
      post: { operationId: 'betaGroups_builds_createToManyRelationship', requestBody: links('BetaGroupBuildsLinkagesRequest'), responses: noContent },
      delete: { operationId: 'betaGroups_builds_deleteToManyRelationship', requestBody: links('BetaGroupBuildsLinkagesRequest'), responses: noContent },
    },
    '/v1/builds/{id}': {
      get: {
        operationId: 'builds_getInstance',
        parameters: [listParam('fields[builds]', ['version', 'betaGroups']), listParam('include', ['app', 'betaGroups']), { $ref: '#/components/parameters/limitBetaGroups' }],
        responses: ok,
      },
    },
    '/v1/builds/{id}/relationships/betaGroups': {
      post: { operationId: 'builds_betaGroups_createToManyRelationship', requestBody: links('BuildBetaGroupsLinkagesRequest'), responses: noContent },
      delete: { operationId: 'builds_betaGroups_deleteToManyRelationship', requestBody: links('BuildBetaGroupsLinkagesRequest'), responses: noContent },
    },
    '/v1/appScreenshotSets/{id}/relationships/appScreenshots': {
      get: { operationId: 'appScreenshotSets_appScreenshots_getToManyRelationship', responses: ok },
      patch: { operationId: 'appScreenshotSets_appScreenshots_replaceToManyRelationship', requestBody: links('AppScreenshotSetAppScreenshotsLinkagesRequest'), responses: noContent },
    },
    '/v1/apps/{id}/customerReviews': { get: { operationId: 'apps_customerReviews', tags: ['Apps'], parameters: [{ name: 'filter[rating]', in: 'query', schema: { type: 'array', items: { type: 'string' } } }], responses: ok } },
    '/v1/customerReviewResponses': { post: { operationId: 'customerReviewResponses_createInstance', tags: ['CustomerReviewResponses'], requestBody: body({ type: 'object', properties: { data: { type: 'object' } } }), responses: ok } },
    '/v1/reviewSubmissions/{id}': {
      get: { operationId: 'reviewSubmissions_getInstance', responses: ok },
      patch: { operationId: 'reviewSubmissions_updateInstance', requestBody: body({ type: 'object' }), responses: ok },
    },
    '/v1/salesReports': { get: { operationId: 'salesReports_getCollection', tags: ['SalesReports'], responses: { 200: { description: 'gz', content: { 'application/a-gzip': {} } } } } },
  },
}));
writeFileSync(join(tmp, 'data/reference/play-discovery.json'), JSON.stringify({
  revision: 'test',
  schemas: {},
  resources: {
    reviews: { methods: {
      list: { id: 'androidpublisher.reviews.list', httpMethod: 'GET', flatPath: 'androidpublisher/v3/applications/{packageName}/reviews', path: 'x' },
      reply: { id: 'androidpublisher.reviews.reply', httpMethod: 'POST', flatPath: 'androidpublisher/v3/applications/{packageName}/reviews/{reviewId}:reply', path: 'x' },
    } },
    edits: { methods: {}, resources: { tracks: { methods: {
      update: { id: 'androidpublisher.edits.tracks.update', httpMethod: 'PUT', flatPath: 'androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}', path: 'x' },
    } } } },
    orders: { methods: { refund: { id: 'androidpublisher.orders.refund', httpMethod: 'POST', flatPath: 'androidpublisher/v3/applications/{packageName}/orders/{orderId}:refund', path: 'x' } } },
  },
}));

const calls = [];
const ids = (type, ...list) => list.map((id) => ({ type, id }));
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const m = init.method ?? 'GET';
  calls.push({ m, url, auth: init.headers?.Authorization, body: init.body });
  if (u.hostname === 'api.appstoreconnect.apple.com') {
    if (u.pathname === '/v1/apps/7/customerReviews') {
      return u.searchParams.get('cursor')
        ? json({ data: [{ id: 'r3' }], links: {} })
        : json({ data: [{ id: 'r1' }, { id: 'r2' }], links: { next: 'https://api.appstoreconnect.apple.com/v1/apps/7/customerReviews?cursor=2' } });
    }
    if (u.pathname === '/v1/salesReports') {
      return new Response(gzipSync('Provider\tUnits\nAPPLE\t12\n'), { headers: { 'content-type': 'application/a-gzip' } });
    }
    if (u.pathname === '/v1/customerReviewResponses' && m === 'POST') return json({ data: { id: 'resp1', type: 'customerReviewResponses' } }, 201);
    if (u.pathname === '/v1/reviewSubmissions/s1') return json({ data: { id: 's1', attributes: { state: 'READY_FOR_REVIEW' } } });
    // Relationship writes answer 204 with no body.
    const empty = () => new Response(null, { status: 204, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v1/betaGroups/g1/relationships/builds') {
      if (m !== 'GET') return empty();
      return u.searchParams.get('cursor')
        ? json({ data: ids('builds', 'b3'), links: {}, meta: { paging: { total: 3, limit: 200 } } })
        : json({ data: ids('builds', 'b1', 'b2'), links: { next: `${u.origin}${u.pathname}?cursor=2&limit=200` }, meta: { paging: { total: 3, limit: 200 } } });
    }
    if (u.pathname === '/v1/builds/b9' && m === 'GET') {
      return json({ data: { type: 'builds', id: 'b9', relationships: { betaGroups: { data: ids('betaGroups', 'g1'), meta: { paging: { total: 1, limit: 50 } } } } } });
    }
    if (u.pathname === '/v1/builds/b9/relationships/betaGroups' && m !== 'GET') return empty();
    if (u.pathname === '/v1/appScreenshotSets/s5/relationships/appScreenshots') {
      return m === 'GET' ? json({ data: ids('appScreenshots', 'a1', 'a2', 'a3'), links: {} }) : empty();
    }
  }
  if (u.hostname === 'analytics.example.apple.com') return new Response(gzipSync('Date\tImpressions\n2026-09-01\t1500\n'));
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'tok', expires_in: 3600 });
  if (u.hostname === 'androidpublisher.googleapis.com') {
    const p = u.pathname.replace('/androidpublisher/v3/applications/com.demo', '');
    if (p === '/edits' && m === 'POST') return json({ id: 'E1' });
    if (p === '/edits/E1' && m === 'DELETE') return new Response(null, { status: 204 });
    if (p === '/edits/E1:commit') return json({ id: 'E1' });
    if (p === '/edits/E1/tracks/production' && m === 'PUT') return json({ track: 'production', releases: JSON.parse(init.body).releases });
    if (p === '/reviews') return json({ reviews: [{ reviewId: 'g1' }] });
    if (p === '/reviews/g1:reply') return json({ result: { replyText: JSON.parse(init.body).replyText } });
  }
  return json({ errors: [{ title: 'unexpected', detail: `${m} ${url}` }] }, 404);
};

const { apiTools } = await import('../plugin/server/api-tools.mjs');
const run = (name, args) => apiTools.find((t) => t.name === name).run(args, { progress() {} });

// Docs.
let r = await run('asc_api_docs', { search: 'review response' });
assert.ok(r.operations[0].includes('POST /v1/customerReviewResponses'));
r = await run('play_api_docs', { search: 'reply' });
assert.ok(r.methods[0].includes('reviews.reply'));

// Reads: paging, query encoding, gzip report to file.
r = await run('asc_api_get', { path: '/v1/apps/7/customerReviews', query: { 'filter[rating]': ['1', '2'] }, all_pages: true });
assert.deepEqual(r.data.map((d) => d.id), ['r1', 'r2', 'r3']);
assert.ok(new URL(calls.find((c) => c.url.includes('customerReviews')).url).searchParams.get('filter[rating]') === '1,2');
r = await run('asc_api_get', { path: '/v1/salesReports', query: { 'filter[vendorNumber]': '8' }, save_to: join(tmp, 'sales.tsv') });
assert.equal(readFileSync(join(tmp, 'sales.tsv'), 'utf8'), 'Provider\tUnits\nAPPLE\t12\n');
assert.deepEqual(r.first_lines.slice(0, 2), ['Provider\tUnits', 'APPLE\t12']);
await assert.rejects(run('asc_api_get', { path: '/v1/salesReports', save_to: join(tmp, 'sales.tsv') }), /already exists/);
await assert.rejects(run('asc_api_get', { path: '/v1/nope' }), /asc_api_docs/);
await assert.rejects(run('asc_api_get', { path: 'https://evil.example.com/v1/apps' }), /must start with/);

// Writes: dry run sends nothing, impact is shown, apply sends the body.
let before = calls.length;
r = await run('asc_api_write', { method: 'POST', path: '/v1/customerReviewResponses', body: { data: { type: 'customerReviewResponses', attributes: { responseBody: 'Thanks!' } } } });
assert.equal(calls.length, before, 'dry run makes no calls');
assert.match(r.impact[0], /public reply/);
r = await run('asc_api_write', { method: 'POST', path: '/v1/customerReviewResponses', body: { data: { type: 'customerReviewResponses', attributes: { responseBody: 'Thanks!' } } }, dry_run: false });
assert.equal(r.status, 201);
assert.equal(JSON.parse(calls.at(-1).body).data.attributes.responseBody, 'Thanks!');
r = await run('asc_api_write', { method: 'PATCH', path: '/v1/reviewSubmissions/s1', body: { data: { type: 'reviewSubmissions', id: 's1', attributes: { submitted: true } } } });
assert.match(r.impact[0], /App Review/);
assert.equal(r.current.state, 'READY_FOR_REVIEW');
await assert.rejects(run('asc_api_write', { method: 'PATCH', path: '/v1/reviewSubmissions/s1', body: { data: { type: 'reviewSubmissions', id: 'other' } } }), /doesn't match/);
await assert.rejects(run('asc_api_write', { method: 'POST', path: '/v1/users', body: { data: { type: 'users' } } }), /user and permission/);
await assert.rejects(run('asc_api_write', { method: 'POST', path: '/v1/customerReviewResponses' }), /needs a body/);

// To-many relationships take a list of identifiers. The dry run only reads the
// current links (every page); the real run treats 204 No Content as success.
r = await run('asc_api_docs', { path: '/v1/betaGroups/g1/relationships/builds', method: 'POST' });
assert.deepEqual(r.operations[0].body, { 'data*': [{ 'type*': 'string: builds', 'id*': 'string' }] });
const addBuilds = { data: ids('builds', 'b1', 'b4') };
before = calls.length;
r = await run('asc_api_write', { method: 'POST', path: '/v1/betaGroups/g1/relationships/builds', body: addBuilds });
assert.deepEqual(calls.slice(before).map((c) => c.m), ['GET', 'GET'], 'dry run reads two pages and writes nothing');
assert.equal(new URL(calls[before].url).searchParams.get('limit'), '200');
assert.equal(r.operation, 'betaGroups_builds_createToManyRelationship');
assert.deepEqual(r.current, { type: 'builds', count: 3, ids: ['b1', 'b2', 'b3'] });
assert.deepEqual(r.changes, { add: ['b4'], already_linked: ['b1'] });
assert.match(r.impact[0], /TestFlight/);
writeFileSync(join(tmp, 'links.json'), JSON.stringify(addBuilds));
const fromFile = await run('asc_api_write', { method: 'POST', path: '/v1/betaGroups/g1/relationships/builds', body_file: join(tmp, 'links.json') });
assert.deepEqual([fromFile.current, fromFile.changes], [r.current, r.changes], 'body_file reads the same');
r = await run('asc_api_write', { method: 'POST', path: '/v1/betaGroups/g1/relationships/builds', body: addBuilds, dry_run: false });
assert.deepEqual([calls.at(-1).m, r.status, r.linked, r.response], ['POST', 204, ['b1', 'b4'], undefined]);
assert.deepEqual(JSON.parse(calls.at(-1).body), addBuilds);

// No read of its own: the parent resource with include tells the current links.
const dropGroups = { data: ids('betaGroups', 'g1', 'g2') };
before = calls.length;
r = await run('asc_api_write', { method: 'DELETE', path: '/v1/builds/b9/relationships/betaGroups', body: dropGroups });
assert.equal(calls.length, before + 1);
const read = new URL(calls.at(-1).url);
assert.deepEqual(
  [read.pathname, read.searchParams.get('include'), read.searchParams.get('limit[betaGroups]'), read.searchParams.get('fields[builds]')],
  ['/v1/builds/b9', 'betaGroups', '50', 'betaGroups'],
);
assert.deepEqual(r.current, { type: 'betaGroups', count: 1, ids: ['g1'] });
assert.deepEqual(r.changes, { remove: ['g1'], not_linked: ['g2'] });
assert.ok(r.impact.some((w) => /only the links/.test(w)) && !r.impact.some((w) => /can't be undone/.test(w)));
r = await run('asc_api_write', { method: 'DELETE', path: '/v1/builds/b9/relationships/betaGroups', body: dropGroups, dry_run: false });
assert.deepEqual([calls.at(-1).m, r.status, r.unlinked], ['DELETE', 204, ['g1', 'g2']]);
assert.deepEqual(JSON.parse(calls.at(-1).body), dropGroups);

// PATCH replaces the whole list; an empty list unlinks everything.
const shots = '/v1/appScreenshotSets/s5/relationships/appScreenshots';
r = await run('asc_api_write', { method: 'PATCH', path: shots, body: { data: ids('appScreenshots', 'a2', 'a1') } });
assert.equal(new URL(calls.at(-1).url).search, '', 'no limit where the read has none');
assert.deepEqual(r.changes, { add: [], remove: ['a3'], after: ['a2', 'a1'] });
assert.match(r.impact.at(-1), /whole list/);
r = await run('asc_api_write', { method: 'PATCH', path: shots, body: { data: [] } });
assert.deepEqual(r.changes, { add: [], remove: ['a1', 'a2', 'a3'], after: [] });
r = await run('asc_api_write', { method: 'PATCH', path: shots, body: { data: ids('appScreenshots', 'a2', 'a1') }, dry_run: false });
assert.deepEqual([calls.at(-1).m, r.status, r.now_linked], ['PATCH', 204, ['a2', 'a1']]);

// An unreadable list still shows what the body asks for.
r = await run('asc_api_write', { method: 'POST', path: '/v1/betaGroups/g404/relationships/builds', body: addBuilds });
assert.match(r.current, /couldn't read/);
assert.deepEqual(r.changes, { add: ['b1', 'b4'] });

// Malformed bodies are still rejected, before any request.
before = calls.length;
const link = (body, path = '/v1/betaGroups/g1/relationships/builds') => run('asc_api_write', { method: 'POST', path, body });
await assert.rejects(link({ data: { type: 'builds', id: 'b1' } }), /must list resource identifiers/);
await assert.rejects(link({ data: [] }), /empty/);
await assert.rejects(link({ data: [{ type: 'builds' }] }), /data\[0\] must be \{"type", "id"\}/);
await assert.rejects(link({ data: [{ type: 'builds', id: 'b1', attributes: {} }] }), /nothing else/);
await assert.rejects(link({ data: ['b1'] }), /data\[0\] must be/);
await assert.rejects(link({ data: ids('apps', '7') }), /must be "builds", not "apps"/);
await assert.rejects(link({ data: ids('customerReviewResponses', 'x') }, '/v1/customerReviewResponses'), /only to-many relationship paths take a list/);
await assert.rejects(link({ data: ids('apps', '7') }, '/v1/users/u1/relationships/visibleApps'), /user and permission/);
assert.equal(calls.length, before);

// Paths that URL parsing would rewrite (encoded or split dot segments,
// backslashes, encoded slashes, fragments) are refused before anything is sent,
// so the blocklists and reference checks always see the real target.
before = calls.length;
for (const path of ['/v1/appScreenshots/%2e%2e\\users\\ID', '/v1/apps/7/%2E%2E/%2e%2e/users/u1', '/v1/apps/7/.%2e/x', '/v1/apps/7/.\t./users', '/v1/apps/7%2Fusers', '/v1/apps/7#/v1/users']) {
  await assert.rejects(run('asc_api_write', { method: 'DELETE', path }), /Refusing the path/, path);
}
await assert.rejects(run('asc_api_get', { path: 'https://api.appstoreconnect.apple.com/v1/apps/7/%2e%2e/%2e%2e/users' }), /Refusing the path/);
await assert.rejects(
  run('play_api_write', { method: 'PUT', path: 'listings/%2e%2e\\%2e%2e\\%2e%2e\\inappproducts\\SKU', package: 'com.demo', in_edit: true, body: {} }),
  /Refusing the path/,
  'a dry run inside an edit cannot reach outside it',
);
await assert.rejects(run('play_api_write', { method: 'POST', path: 'applications/com.demo/orders/o1:refund#/reviews/g1:reply' }), /Refusing the path/);
await assert.rejects(run('play_api_get', { path: 'applications/com.demo/reviews/%2e%2e/%2e%2e/x' }), /Refusing the path/);
assert.equal(calls.length, before, 'nothing sent');
// The clients check every path too, whatever built it.
const { GooglePlay } = await import('../plugin/server/play.mjs');
const { AppStoreConnect } = await import('../plugin/server/asc.mjs');
await assert.rejects(new GooglePlay({ serviceAccount: saJson }).listing('com.demo', 'E1', '..'), /Refusing the path/);
assert.throws(() => new AppStoreConnect({}).url('/v1/apps/%2e%2e/users'), /Refusing the path/);

// Key files never become a body or a save target, and errors never quote a file.
const reply = { method: 'POST', path: 'applications/com.demo/reviews/g1:reply' };
await assert.rejects(run('asc_api_write', { method: 'POST', path: '/v1/customerReviewResponses', body_file: join(tmp, 'key.p8') }), /is a key file/);
let err = await run('play_api_write', { ...reply, body_file: join(tmp, 'sa.json') }).catch((e) => e);
assert.match(err.message, /holds a private key/);
assert.ok(!err.message.includes('BEGIN'));
writeFileSync(join(tmp, 'broken.json'), '{"note": oops');
err = await run('play_api_write', { ...reply, body_file: join(tmp, 'broken.json') }).catch((e) => e);
assert.match(err.message, /isn't valid JSON/);
assert.ok(!err.message.includes('oops'), 'the file is not quoted');
await assert.rejects(run('play_api_write', { ...reply, body: { replyText: '-----BEGIN PRIVATE KEY-----\nx' } }), /private key/);
for (const file of ['key.p8', 'sa.json']) {
  await assert.rejects(run('asc_api_get', { path: '/v1/salesReports', save_to: join(tmp, file), overwrite: true }), /is a key file/);
}

// Downloads: allowed hosts only, never with credentials.
await assert.rejects(run('asc_download_file', { url: 'https://evil.example.com/x', save_to: join(tmp, 'x') }), /unexpected URL host/);
r = await run('asc_download_file', { url: 'https://analytics.example.apple.com/seg.gz', save_to: join(tmp, 'seg.tsv') });
assert.equal(r.first_lines[1], '2026-09-01\t1500');
assert.equal(calls.at(-1).auth, undefined, 'no token to download hosts');
assert.ok(calls.filter((c) => c.auth?.startsWith('Bearer ey')).every((c) => new URL(c.url).hostname === 'api.appstoreconnect.apple.com'), 'Apple token only goes to the API host');

// Play: reads, a reply, and a track change validated inside a thrown-away edit.
r = await run('play_api_get', { path: 'applications/com.demo/reviews' });
assert.equal(r.reviews[0].reviewId, 'g1');
before = calls.length;
r = await run('play_api_write', { method: 'POST', path: 'applications/com.demo/reviews/g1:reply', body: { replyText: 'Thanks!' } });
assert.equal(calls.length, before);
assert.match(r.impact[0], /public reply/);
r = await run('play_api_write', { method: 'POST', path: 'applications/com.demo/reviews/g1:reply', body: { replyText: 'Thanks!' }, dry_run: false });
assert.equal(r.response.result.replyText, 'Thanks!');
const release = { releases: [{ versionCodes: ['42'], status: 'inProgress', userFraction: 0.1 }] };
r = await run('play_api_write', { method: 'PUT', path: 'tracks/production', package: 'com.demo', in_edit: true, body: release });
assert.match(r.validated, /thrown away/);
assert.ok(calls.some((c) => c.m === 'DELETE' && c.url.endsWith('/edits/E1')) && !calls.some((c) => c.url.includes(':commit')));
r = await run('play_api_write', { method: 'PUT', path: 'tracks/production', package: 'com.demo', in_edit: true, body: release, dry_run: false });
assert.ok(calls.at(-1).url.endsWith(':commit?changesNotSentForReview=true'));
await assert.rejects(run('play_api_write', { method: 'POST', path: 'applications/com.demo/orders/o1:refund', dry_run: false }), /order refunds/);
await assert.rejects(run('play_api_write', { method: 'POST', path: 'applications/com.demo/nothing' }), /play_api_docs/);

console.log('api tool checks passed');
