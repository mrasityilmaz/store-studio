// Generic tools over the whole App Store Connect and Google Play APIs:
// reference lookup, reads, and confirmed writes. No code is executed.
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CONFIRM, accounts, accountsFile, asc, ascAccountNames, ascForApp, play, playAccountNames, playForPackage } from './clients.mjs';
import { ascDocs, ascFindOperation, ascLinkageTypes, ascParam, ascSpec, playDiscovery, playDocs, playFindMethod } from './docs.mjs';
import { HOST as PLAY_HOST } from './play.mjs';
import { StoreError, assertHost, assertPlainPath, dataDir, fetchRetry } from './util.mjs';

const ACCOUNT = {
  type: 'string',
  description: 'Account name; needed when several accounts are set up and the path names no app',
};

// With several accounts, the app in the path picks one: /v1/apps/{id}/… for
// App Store Connect, applications/{package}/… for Play.
async function ascClientFor(path, account) {
  const names = ascAccountNames();
  if (account || names.length <= 1) return asc(account);
  const appId = path.replace(/^https:\/\/[^/]+/, '').match(/^\/v\d+\/apps\/(\d+)(?:[/?]|$)/)?.[1];
  if (appId) return (await ascForApp(appId)).client;
  throw new StoreError(`Several App Store Connect accounts are set up (${names.join(', ')}); pass account. asc_apps shows which account has which app.`);
}

async function playClientFor(path, pkg, account) {
  const names = playAccountNames();
  if (account || names.length <= 1) return play(account);
  const found = pkg ?? path.match(/applications\/([^/:?]+)/)?.[1];
  if (found) return (await playForPackage(decodeURIComponent(found))).client;
  throw new StoreError(`Several Google Play accounts are set up (${names.join(', ')}); pass account or package.`);
}

// Money movement and account access stay in the store consoles.
const ASC_BLOCKED = [
  [/^\/v\d+\/(users|userInvitations)(\/|$)/, 'user and permission management'],
];
const PLAY_BLOCKED = [
  [/\/orders\//, 'order refunds'],
  [/\/purchases\//, 'purchase refunds, revocations and cancellations'],
  [/externalTransactions/, 'external transactions'],
  [/\/developers\/[^/]+\/users/, 'user and permission management'],
];

// Writes that reach users, prices or reviews get an explicit warning.
const ASC_IMPACT = [
  [/^\/v1\/reviewSubmissions\/[^/]+$/, (b) => b?.data?.attributes?.submitted === true && 'Sends the app to App Review.'],
  [/^\/v1\/appStoreVersionReleaseRequests$/, () => 'Releases the approved version to users now.'],
  [/PhasedReleases/, () => 'Changes the phased rollout of a live release.'],
  [/(PriceSchedules|Prices|PricePoints)/, () => 'Changes the prices customers pay.'],
  [/(appAvailabilities|territoryAvailabilities)/, () => 'Changes the countries where the app is sold.'],
  [/^\/v1\/customerReviewResponses$/, () => 'Posts a public reply under a customer review.'],
  [
    /^\/v1\/(apps|betaGroups|betaTesters|builds)\/[^/]+\/relationships\/(betaGroups|betaTesters|builds|individualTesters)$/,
    () => 'Changes who can test which builds in TestFlight; testers may be notified.',
  ],
];
const PLAY_IMPACT = [
  [/\/tracks/, () => 'Changes a release track; a production release reaches users after review.'],
  [/:reply$/, () => 'Posts a public reply under a user review.'],
  [/\/dataSafety$/, () => 'Replaces the Data safety section shown on the store listing.'],
  [/(subscriptions|inappproducts|onetimeproducts|basePlans|offers)/i, () => 'Changes in-app products, subscriptions or their prices.'],
  [/appRecoveries/, () => 'Targets app recovery actions at users\' installed apps.'],
];

const QUERY = {
  type: 'object',
  description: 'Query parameters, e.g. {"filter[platform]": "IOS", "limit": 50}. Arrays are joined with commas.',
  additionalProperties: { type: ['string', 'number', 'boolean', 'array'] },
};
const SAVE = {
  save_to: { type: 'string', description: 'Absolute file path; the response is written there instead of returned' },
  overwrite: { type: 'boolean', default: false },
};

function blocked(list, path) {
  const hit = list.find(([re]) => re.test(path));
  if (hit) throw new StoreError(`store-studio doesn't change ${hit[1]}; do it in the store console.`);
}

const impact = (list, path, body) => list.map(([re, f]) => re.test(path) && f(body)).filter(Boolean);

const real = (file) => realpath(file).catch(() => resolve(file));

// Key files and the accounts file are never read as a body or written over.
async function assertNotKeyFile(file) {
  let configured = [];
  try {
    const all = accounts();
    configured = [
      ...Object.values(all.asc).map((a) => a.keyPath),
      ...Object.values(all.play).map((a) => a.serviceAccountPath),
      accountsFile(),
    ];
  } catch {}
  const path = await real(file);
  const keys = await Promise.all(configured.filter(Boolean).map(real));
  if (/\.p8$/i.test(path) || keys.includes(path)) {
    throw new StoreError(`${file} is a key or accounts file; store-studio never sends, shows or overwrites those.`);
  }
}

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:/;

// The body from body or body_file. Key material is refused, and errors never
// quote the file, so a wrong path can't put a key into the conversation.
async function readBody({ body, body_file }) {
  let payload = body;
  if (body_file) {
    if (!isAbsolute(body_file)) throw new StoreError('body_file must be an absolute path');
    await assertNotKeyFile(body_file);
    let text;
    try {
      text = await readFile(body_file, 'utf8');
    } catch (err) {
      throw new StoreError(`Couldn't read ${body_file} (${err.code ?? 'read error'})`);
    }
    if (PRIVATE_KEY.test(text)) throw new StoreError(`${body_file} holds a private key; store-studio never sends or shows key contents.`);
    try {
      payload = JSON.parse(text);
    } catch {
      throw new StoreError(`${body_file} isn't valid JSON`);
    }
  }
  if (payload && PRIVATE_KEY.test(JSON.stringify(payload))) {
    throw new StoreError('The body holds a private key; store-studio never sends or shows key contents.');
  }
  return payload;
}

async function target(save_to, overwrite, fallbackName) {
  const file = save_to ?? join(dataDir(), 'downloads', `${new Date().toISOString().replace(/[:.]/g, '-')}-${fallbackName}`);
  if (!isAbsolute(file)) throw new StoreError('save_to must be an absolute path');
  await assertNotKeyFile(file);
  if (!overwrite && (await stat(file).catch(() => null))) {
    throw new StoreError(`${file} already exists; pass overwrite: true or pick another path`);
  }
  await mkdir(dirname(file), { recursive: true });
  return file;
}

// Writes bytes (gunzipped when gzip) and describes what was saved.
async function saveBytes(buf, file) {
  const data = buf[0] === 0x1f && buf[1] === 0x8b && !file.endsWith('.gz') ? gunzipSync(buf) : buf;
  await writeFile(file, data);
  const text = data.subarray(0, 4096).toString('utf8');
  const printable = !/[\u0000-\u0008\u000e-\u001f]/.test(text);
  return {
    saved: file,
    bytes: data.length,
    ...(printable && { first_lines: text.split('\n').slice(0, 6).map((l) => l.slice(0, 300)) }),
  };
}

const isJson = (type) => type.includes('json');

// ------------------------------------------------------------ App Store Connect

async function ascValidate(method, path) {
  // The reference is optional for reads; offline, the API itself answers.
  let index;
  try {
    index = await ascSpec();
  } catch (err) {
    if (method === 'GET') return null;
    throw err;
  }
  const op = ascFindOperation(index, method, path.replace(/^https:\/\/api\.appstoreconnect\.apple\.com/, ''));
  if (!op) throw new StoreError(`App Store Connect has no ${method} ${path.split('?')[0]}; look it up with asc_api_docs`);
  return op;
}

function checkAscPath(path) {
  if (!/^\/v\d+\//.test(path) && !path.startsWith('https://api.appstoreconnect.apple.com/')) {
    throw new StoreError('path must start with /v1/ (or another /vN/)');
  }
  if (path.includes('..')) throw new StoreError('path must not contain ..');
  assertPlainPath(path);
}

// To-many relationship writes (…/relationships/{name}) take a list of
// resource identifiers; returns their ids.
function linkageIds(method, payload, types) {
  const shape = `{"data": [{"type": "${types[0] ?? '…'}", "id": "…"}]}`;
  const data = payload?.data;
  if (!Array.isArray(data)) throw new StoreError(`body must list resource identifiers: ${shape}`);
  if (!data.length && method !== 'PATCH') throw new StoreError(`body data is empty; list at least one: ${shape}`);
  data.forEach((d, i) => {
    const keys = d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d).sort().join() : '';
    if (keys !== 'id,type' || typeof d.type !== 'string' || typeof d.id !== 'string' || !d.id) {
      throw new StoreError(`body data[${i}] must be {"type", "id"} and nothing else: ${shape}`);
    }
    if (types.length && !types.includes(d.type)) {
      throw new StoreError(`body data[${i}].type must be ${types.map((t) => `"${t}"`).join(' or ')}, not "${d.type}"`);
    }
  });
  return data.map((d) => d.id);
}

const MAX_LINKS = 1000;
const SHOW_LINKS = 100;

// What a to-many relationship links to now: its own GET when Apple has one,
// otherwise the parent resource read with include (one page at most).
async function currentLinks(client, index, bare) {
  const own = ascFindOperation(index, 'GET', bare);
  if (own) {
    const limit = ascParam(index, own, 'limit');
    const ids = [];
    let url = client.url(bare, limit && { limit: limit.schema?.maximum ?? 200 });
    let total;
    while (url && ids.length < MAX_LINKS) {
      const page = await client.req('GET', url);
      ids.push(...(page?.data ?? []).map((d) => d.id));
      total ??= page?.meta?.paging?.total;
      url = page?.links?.next;
    }
    return { ids, total: total ?? (url ? `more than ${ids.length}` : ids.length), complete: !url };
  }
  const [, parent, rel] = bare.match(/^(.+)\/relationships\/([^/]+)$/) ?? [];
  const get = parent && ascFindOperation(index, 'GET', parent);
  if (!get || !ascParam(index, get, 'include')?.schema?.items?.enum?.includes(rel)) return null;
  const query = { include: rel };
  const limit = ascParam(index, get, `limit[${rel}]`)?.schema?.maximum;
  if (limit) query[`limit[${rel}]`] = limit;
  const fields = `fields[${parent.split('/').at(-2)}]`;
  if (ascParam(index, get, fields)?.schema?.items?.enum?.includes(rel)) query[fields] = rel;
  const linkage = (await client.req('GET', client.url(parent, query)))?.data?.relationships?.[rel];
  const ids = (linkage?.data ?? []).map((d) => d.id);
  const total = linkage?.meta?.paging?.total ?? ids.length;
  return { ids, total, complete: ids.length >= total };
}

// What a to-many write adds and removes; without the full current list, only
// what the body asks for.
function linkChanges(method, ids, now) {
  const want = [...new Set(ids)];
  if (!now?.complete) return { POST: { add: want }, DELETE: { remove: want }, PATCH: { replace_with: want } }[method];
  const have = new Set(now.ids);
  const linked = want.filter((id) => have.has(id));
  const unlinked = want.filter((id) => !have.has(id));
  if (method === 'POST') return { add: unlinked, ...(linked.length && { already_linked: linked }) };
  if (method === 'DELETE') return { remove: linked, ...(unlinked.length && { not_linked: unlinked }) };
  const keep = new Set(want);
  return { add: unlinked, remove: now.ids.filter((id) => !keep.has(id)), after: want };
}

function describeLinks(now, types) {
  if (!now) return "unknown: App Store Connect has no read for this relationship, so check it in App Store Connect";
  if (typeof now === 'string') return now;
  const hidden = now.ids.length - SHOW_LINKS;
  return {
    ...(types.length && { type: types.join(' | ') }),
    count: now.total,
    ids: now.ids.slice(0, SHOW_LINKS),
    ...(hidden > 0 && { more: hidden }),
    ...(!now.complete && { note: `Only ${now.ids.length} of ${now.total} links could be read, so the changes only list what the body asks for.` }),
  };
}

export const apiTools = [
  {
    name: 'asc_api_docs',
    description:
      "Looks up Apple's official App Store Connect OpenAPI reference (every endpoint: versions, builds, review submissions, age ratings, encryption, pricing, in-app purchases, subscriptions, custom product pages, experiments, customer reviews, analytics and sales reports, TestFlight…). search finds operations by keywords; path (+ method) shows parameters, request body and response; schema shows one component. Use before asc_api_get or asc_api_write.",
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Keywords, e.g. "phased release" or "customer review response"' },
        path: { type: 'string', description: 'An operation path, template or concrete, e.g. /v1/apps/{id}/customerReviews' },
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
        schema: { type: 'string', description: 'A component schema name, e.g. AppStoreVersion' },
      },
    },
    run: (args) => ascDocs(args),
  },

  {
    name: 'asc_api_get',
    description:
      'Reads any App Store Connect API resource (GET). Keep results small with fields[type], filter[...], include and limit (max 200); all_pages follows links.next. Gzipped reports (salesReports, financeReports) and any response with save_to go to a local file, ready to analyze.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        account: ACCOUNT,
        path: { type: 'string', description: 'e.g. /v1/apps/123/customerReviews, or a links.next URL' },
        query: QUERY,
        all_pages: { type: 'boolean', default: false },
        max_items: { type: 'integer', default: 1000, description: 'Stop following pages after this many items' },
        ...SAVE,
      },
    },
    async run({ account, path, query, all_pages = false, max_items = 1000, save_to, overwrite = false }) {
      checkAscPath(path);
      await ascValidate('GET', path);
      const client = await ascClientFor(path, account);
      let res = await client.raw('GET', path, { query });
      if (!isJson(res.type)) {
        const file = await target(save_to, overwrite, `${basename(path.split('?')[0])}.txt`);
        return saveBytes(res.buf, file);
      }
      const first = JSON.parse(res.buf.toString('utf8'));
      if (all_pages && Array.isArray(first.data)) {
        const included = [...(first.included ?? [])];
        let next = first.links?.next;
        while (next && first.data.length < max_items) {
          res = await client.raw('GET', next);
          const page = JSON.parse(res.buf.toString('utf8'));
          first.data.push(...page.data);
          included.push(...(page.included ?? []));
          next = page.links?.next;
        }
        first.links = { ...first.links, next };
        if (included.length) first.included = included;
      }
      if (save_to) {
        const file = await target(save_to, overwrite, 'response.json');
        await writeFile(file, JSON.stringify(first, null, 2));
        return { saved: file, items: Array.isArray(first.data) ? first.data.length : 1, next: first.links?.next ?? null };
      }
      return first;
    },
  },

  {
    name: 'asc_api_write',
    description:
      'Creates, updates or deletes any App Store Connect resource (POST, PATCH, DELETE), checked against Apple\'s reference. To-many relationship paths (…/relationships/{name}, shown with data*: [ … ] in asc_api_docs) take a list of identifiers: POST adds links, DELETE removes them, PATCH replaces the list; success is 204 with no content. Dry run by default: shows the request, the current state of the resource (for relationships, the linked ids and what will be added or removed) and any user-facing impact. Run with dry_run: false only after the user confirms. User and permission management is not available.',
    inputSchema: {
      type: 'object',
      required: ['method', 'path'],
      properties: {
        account: ACCOUNT,
        method: { type: 'string', enum: ['POST', 'PATCH', 'DELETE'] },
        path: { type: 'string' },
        body: {
          type: 'object',
          description: 'JSON:API body: {"data": {"type", "id", "attributes", "relationships"}}, or for a to-many relationship path {"data": [{"type", "id"}, …]}',
        },
        body_file: { type: 'string', description: 'Absolute path to a JSON file used as the body' },
        dry_run: { type: 'boolean', default: true },
      },
    },
    async run({ account, method, path, body, body_file, dry_run = true }) {
      checkAscPath(path);
      const bare = path.replace(/^https:\/\/api\.appstoreconnect\.apple\.com/, '').split('?')[0];
      blocked(ASC_BLOCKED, bare);
      const op = await ascValidate(method, bare);
      const index = await ascSpec();
      const payload = await readBody({ body, body_file });
      if (op.op.requestBody?.required && !payload) throw new StoreError(`${method} ${op.path} needs a body; see asc_api_docs`);
      const linkTypes = ascLinkageTypes(index, op);
      const links = linkTypes && linkageIds(method, payload, linkTypes);
      if (!links && payload && (Array.isArray(payload.data) || !payload.data?.type)) {
        throw new StoreError('body must be JSON:API: {"data": {"type": …}}; only to-many relationship paths take a list');
      }
      if (method === 'PATCH' && payload?.data?.id && !bare.endsWith(`/${payload.data.id}`) && !bare.includes('/relationships/')) {
        throw new StoreError(`body data.id ${payload.data.id} doesn't match the path`);
      }
      const client = await ascClientFor(bare, account);
      const warnings = impact(ASC_IMPACT, bare, payload);
      if (links && method === 'DELETE') warnings.push(`Removes only the links; the ${linkTypes.join('/') || 'resources'} themselves aren't deleted.`);
      else if (links && method === 'PATCH') warnings.push('Replaces the whole list: anything linked now but missing from the body is unlinked.');
      else if (method === 'DELETE') warnings.push("Deletes this resource; it can't be undone.");
      if (dry_run) {
        let current;
        let changes;
        if (links) {
          const now = await currentLinks(client, index, bare).catch((e) => `couldn't read: ${e.message}`);
          current = describeLinks(now, linkTypes);
          changes = linkChanges(method, links, typeof now === 'string' ? null : now);
        } else if (method !== 'POST') {
          if (ascFindOperation(index, 'GET', bare) && !bare.includes('/relationships/')) {
            current = await client.req('GET', bare).then((r) => r?.data?.attributes ?? r?.data).catch((e) => `couldn't read: ${e.message}`);
          }
        }
        return {
          request: `${method} ${bare}`,
          operation: op.id,
          ...(payload && { body: payload }),
          ...(current !== undefined && { current }),
          ...(changes && { changes }),
          ...(warnings.length && { impact: warnings }),
          note: CONFIRM,
        };
      }
      const res = await client.raw(method, bare, { body: payload });
      // Relationship writes answer 204 No Content.
      const out = res.buf.length && isJson(res.type) ? JSON.parse(res.buf.toString('utf8')) : null;
      return {
        done: `${method} ${bare}`,
        status: res.status,
        ...(links && { [{ POST: 'linked', DELETE: 'unlinked', PATCH: 'now_linked' }[method]]: links }),
        ...(out && { response: out.data ?? out }),
      };
    },
  },

  {
    name: 'asc_download_file',
    description:
      'Downloads a file Apple links to from an API response, such as an analytics report segment URL, to a local path (gunzipped). No credentials are sent. Then analyze the file locally.',
    inputSchema: {
      type: 'object',
      required: ['url', 'save_to'],
      properties: { url: { type: 'string' }, ...SAVE },
    },
    async run({ url, save_to, overwrite = false }) {
      assertHost(url, ['apple.com', 'mzstatic.com']);
      const file = await target(save_to, overwrite, 'download');
      const res = await fetchRetry(url, {});
      if (!res.ok) throw new StoreError(`Download failed (${res.status})`);
      return saveBytes(Buffer.from(await res.arrayBuffer()), file);
    },
  },

  // ------------------------------------------------------------ Google Play

  {
    name: 'play_api_docs',
    description:
      "Looks up Google's official Play Developer API reference (every method: edits, tracks and staged rollouts, testers, country availability, reviews, Data safety, subscriptions, in-app products, app recovery…). search finds methods; id or path shows parameters, body and response. Use before play_api_get or play_api_write.",
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        id: { type: 'string', description: 'Method id, e.g. androidpublisher.reviews.reply' },
        path: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      },
    },
    run: (args) => playDocs(args),
  },

  {
    name: 'play_api_get',
    description:
      'Reads any Google Play Developer API resource (GET). path is under androidpublisher/v3/, e.g. applications/com.example/reviews. With in_edit, path is relative to a temporary edit of package (e.g. tracks, details, listings) that is thrown away afterwards.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        account: ACCOUNT,
        path: { type: 'string' },
        query: QUERY,
        package: { type: 'string', description: 'Needed with in_edit' },
        in_edit: { type: 'boolean', default: false },
        ...SAVE,
      },
    },
    async run({ account, path, query, package: pkg, in_edit = false, save_to, overwrite = false }) {
      assertPlainPath(path);
      const client = await playClientFor(path, pkg, account);
      const call = async (full) => {
        await playValidate('GET', full);
        const res = await client.raw('GET', playUrl(full, query));
        if (save_to || !isJson(res.type)) {
          return saveBytes(res.buf, await target(save_to, overwrite, 'play-response.json'));
        }
        return res.buf.length ? JSON.parse(res.buf.toString('utf8')) : null;
      };
      if (!in_edit) return call(playPath(path));
      if (!pkg) throw new StoreError('in_edit needs package');
      return client.withEdit(pkg, (edit) => call(editPath(pkg, edit, path)));
    },
  },

  {
    name: 'play_api_write',
    description:
      "Changes any Google Play Developer API resource (POST, PUT, PATCH, DELETE), checked against Google's reference. With in_edit, the change runs inside an edit of package: a dry run sends it into a temporary edit so Google validates it, then throws the edit away; a real run commits it (not sent for review unless send_for_review). Without in_edit, a dry run only describes the request. Run with dry_run: false only after the user confirms. Refunds, purchases and user management are not available.",
    inputSchema: {
      type: 'object',
      required: ['method', 'path'],
      properties: {
        account: ACCOUNT,
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string' },
        query: QUERY,
        body: { type: 'object' },
        body_file: { type: 'string', description: 'Absolute path to a JSON file used as the body' },
        package: { type: 'string', description: 'Needed with in_edit' },
        in_edit: { type: 'boolean', default: false },
        dry_run: { type: 'boolean', default: true },
        send_for_review: { type: 'boolean', default: false },
      },
    },
    async run({ account, method, path, query, body, body_file, package: pkg, in_edit = false, dry_run = true, send_for_review = false }) {
      assertPlainPath(path);
      const client = await playClientFor(path, pkg, account);
      const payload = await readBody({ body, body_file });
      const warnings = impact(PLAY_IMPACT, path, payload);
      if (method === 'DELETE') warnings.push("Deletes this resource; it can't be undone.");
      const send = async (full) => {
        blocked(PLAY_BLOCKED, `/${full}`);
        const m = await playValidate(method, full);
        if (m?.supportsMediaUpload) throw new StoreError('Media uploads go through play_screenshots_push');
        const res = await client.raw(method, playUrl(full, query), payload ? { json: payload } : {});
        return res.buf.length && isJson(res.type) ? JSON.parse(res.buf.toString('utf8')) : null;
      };
      if (in_edit) {
        if (!pkg) throw new StoreError('in_edit needs package');
        const response = await client.withEdit(pkg, (edit) => send(editPath(pkg, edit, path)), {
          commit: !dry_run,
          sendForReview: send_for_review,
        });
        return dry_run
          ? { request: `${method} edits/…/${path}`, validated: 'Google accepted this change in a temporary edit, which was thrown away.', response, ...(warnings.length && { impact: warnings }), note: CONFIRM }
          : { done: `${method} edits/…/${path}`, response, review: send_for_review ? 'sent for review' : 'waiting in Play Console until you send it for review' };
      }
      const full = playPath(path);
      if (dry_run) {
        blocked(PLAY_BLOCKED, `/${full}`);
        const m = await playValidate(method, full);
        return {
          request: `${method} ${full}`,
          ...(m && { operation: m.id }),
          ...(payload && { body: payload }),
          ...(warnings.length && { impact: warnings }),
          note: CONFIRM,
        };
      }
      return { done: `${method} ${full}`, response: await send(full) };
    },
  },
];

// ------------------------------------------------------------ Play helpers

function playPath(path) {
  const p = path.replace(/^https:\/\/androidpublisher\.googleapis\.com\//, '').replace(/^\//, '');
  if (p.includes('..')) throw new StoreError('path must not contain ..');
  assertPlainPath(p);
  return p.startsWith('androidpublisher/') ? p : `androidpublisher/v3/${p}`;
}

function editPath(pkg, edit, path) {
  const rel = path.replace(/^\//, '');
  if (rel.includes('..')) throw new StoreError('path must not contain ..');
  assertPlainPath(rel);
  return `androidpublisher/v3/applications/${encodeURIComponent(pkg)}/edits/${edit}${rel ? `/${rel}` : ''}`;
}

function playUrl(full, query) {
  const u = new URL(`${PLAY_HOST}/${full}`);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  return u.href;
}

async function playValidate(method, full) {
  let index;
  try {
    index = await playDiscovery();
  } catch (err) {
    if (method === 'GET') return null;
    throw err;
  }
  const m = playFindMethod(index, method, full);
  if (!m) throw new StoreError(`Google Play has no ${method} ${full}; look it up with play_api_docs`);
  return m;
}
