import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { INFO_FIELDS, VERSION_FIELDS, imageUrl } from './asc.mjs';
import {
  CONFIRM,
  accounts,
  asc,
  ascForApp,
  play,
  playForPackage,
  preview,
} from './clients.mjs';
import { contentType } from './image.mjs';
import { LISTING_FIELDS } from './play.mjs';
import { uploadIpa } from './ipa.mjs';
import { describeFiles, scanAsc, scanPlay } from './scan.mjs';
import { ASC_DISPLAY_TYPES, ASC_LIMITS, ASC_LIVE, ASC_PLATFORMS, PLAY_IMAGE_TYPES, PLAY_LIMITS } from './specs.mjs';
import { StoreError, assertHost, charCount, fetchRetry, pool, setupHint } from './util.mjs';

// ---------------------------------------------------------------- helpers

function limitErrors(changes, limits, key) {
  const errors = [];
  for (const c of changes) {
    for (const [field, max] of Object.entries(limits)) {
      if (c[field] != null && charCount(c[field]) > max) {
        errors.push(`${c[key]}.${field}: ${charCount(c[field])} characters, limit is ${max}`);
      }
    }
  }
  return errors;
}

const pickLocales = (list, wanted, key) =>
  wanted?.length ? list.filter((x) => wanted.some((w) => w.toLowerCase() === x[key].toLowerCase())) : list;

// Saves to `base` plus the extension the server's content type implies.
async function download(url, base, domains) {
  assertHost(url, domains);
  const res = await fetchRetry(url, {});
  if (!res.ok) throw new StoreError(`Download failed (${res.status}): ${url}`);
  const type = res.headers.get('content-type') ?? '';
  const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
  await writeFile(`${base}.${ext}`, Buffer.from(await res.arrayBuffer()));
}

// Readable version: the editable one, else the newest. With live, the one on
// the store now comes first.
async function ascVersion(client, appId, platform, { editable, live = false }) {
  if (editable) return client.editableVersion(appId, platform);
  const versions = await client.versions(appId, platform);
  if (!versions.length) throw new StoreError(`The app has no ${platform} versions yet`);
  return (
    (live ? versions.find((v) => ASC_LIVE.has(v.state)) : undefined) ??
    versions.find((v) => v.state === 'PREPARE_FOR_SUBMISSION') ??
    versions[0]
  );
}

// ---------------------------------------------------------------- tools

const S = {
  app: { type: 'string', description: 'Bundle ID (com.example.app) or numeric Apple ID' },
  platform: { type: 'string', enum: ASC_PLATFORMS, default: 'IOS' },
  pkg: { type: 'string', description: 'Android package name (com.example.app)' },
  locales: { type: 'array', items: { type: 'string' }, description: 'Only these locales (e.g. en-US, tr, de-DE)' },
  languages: { type: 'array', items: { type: 'string' }, description: 'Only these Play languages (e.g. en-US, tr-TR)' },
  dryRun: { type: 'boolean', default: true, description: 'true (default) only reports what would change' },
  account: {
    type: 'string',
    description: 'Account name; only needed when several accounts can see the app (setup_check lists them)',
  },
  sendForReview: {
    type: 'boolean',
    default: false,
    description:
      'false (default) commits the changes but leaves them in Play Console under changes not yet sent for review; true sends them for review, after which Play publishes them',
  },
};

export const tools = [
  {
    name: 'setup_check',
    description:
      'Shows every App Store Connect and Google Play account set in the plugin settings (up to three per store) and tests each one: which apps it sees, and Play access to a package. Never prints key contents. Use it first, and when a store tool reports a setup or permission problem.',
    inputSchema: {
      type: 'object',
      properties: {
        live: { type: 'boolean', default: true, description: 'Also sign in to each configured account' },
        package: { type: 'string', description: 'Optional Android package to test Play access for' },
      },
    },
    async run({ live = true, package: pkg }) {
      const all = accounts();
      const out = { settings: '/plugin > Installed > store-studio > Configure options', app_store: {}, google_play: {} };
      for (const [name, a] of Object.entries(all.asc)) {
        const row = { slot: a.slot, key_id: a.keyId ?? null };
        if (live) {
          try {
            row.apps = (await asc(name).apps()).map((x) => `${x.name} (${x.bundleId})`);
            row.ok = true;
          } catch (err) {
            row.ok = false;
            row.error = [err.message, ...(err.details ?? [])].join(' ');
          }
        }
        out.app_store[name] = row;
      }
      for (const [name, a] of Object.entries(all.play)) {
        const row = { slot: a.slot };
        try {
          const client = play(name);
          row.service_account = (await client.account()).client_email;
          if (live) {
            await client.token();
            row.ok = true;
            if (pkg) {
              await client.withEdit(pkg, async () => {});
              row.package_access = `${pkg}: ok`;
            }
          }
        } catch (err) {
          row.ok = false;
          row.error = err.message;
        }
        out.google_play[name] = row;
      }
      if (!Object.keys(all.asc).length || !Object.keys(all.play).length) out.hint = setupHint();
      return out;
    },
  },

  {
    name: 'screenshots_validate',
    description:
      'Checks a local screenshot folder against App Store or Google Play rules (sizes, slots, alpha, counts) without contacting the store. App Store layout: <dir>/<locale>/<any-folder>/*.png, where pixel size picks the display type (or name the folder APP_IPHONE_67 etc.). Play layout: <dir>/<language>/<phone|tablet-7|tablet|tv|wear|feature-graphic>/*.png.',
    inputSchema: {
      type: 'object',
      required: ['store', 'dir'],
      properties: {
        store: { type: 'string', enum: ['app_store', 'google_play'] },
        dir: { type: 'string', description: 'Absolute path to the folder that holds the locale folders' },
        locales: S.locales,
        devices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these device folders or types (folder name, APP_IPHONE_65, phoneScreenshots…)',
        },
      },
    },
    async run({ store, dir, locales, devices }) {
      if (store === 'app_store') {
        const scan = await scanAsc(dir, { locales, devices });
        return {
          root: scan.root,
          ok: !scan.errors.length,
          locales: scan.locales.map((l) => ({
            locale: l.locale,
            sets: l.sets.map((s) => ({
              folder: s.folder,
              display_type: s.displayType,
              label: ASC_DISPLAY_TYPES[s.displayType]?.label,
              images: describeFiles(s.files),
            })),
          })),
          errors: scan.errors,
        };
      }
      const scan = await scanPlay(dir, { languages: locales, types: devices });
      return {
        root: scan.root,
        ok: !scan.errors.length,
        languages: scan.languages.map((l) => ({
          language: l.language,
          sets: l.sets.map((s) => ({ folder: s.folder, image_type: s.imageType, images: describeFiles(s.files) })),
        })),
        errors: scan.errors,
        warnings: scan.warnings,
      };
    },
  },

  // ------------------------------------------------------------ App Store

  {
    name: 'asc_apps',
    description: 'Lists the apps in every configured App Store Connect account, with the account each one belongs to.',
    inputSchema: { type: 'object', properties: { account: S.account } },
    async run({ account }) {
      const names = account ? [account] : Object.keys(accounts().asc);
      if (!names.length) asc();
      const rows = [];
      for (const name of names) {
        for (const a of await asc(name).apps()) {
          rows.push({ account: name, name: a.name, bundle_id: a.bundleId, apple_id: a.id, primary_locale: a.primaryLocale });
        }
      }
      return rows;
    },
  },

  {
    name: 'asc_status',
    description:
      'Shows an app\'s versions, the version that can be edited, its localizations and how many screenshots each display type has.',
    inputSchema: { type: 'object', required: ['app'], properties: { account: S.account, app: S.app, platform: S.platform } },
    async run({ account, app, platform = 'IOS' }, ctx) {
      const { client, app: a } = await ascForApp(app, account);
      const versions = await client.versions(a.id, platform);
      const version = versions.find((v) => v.state === 'PREPARE_FOR_SUBMISSION') ?? versions[0];
      const out = {
        app: `${a.name} (${a.bundleId})`,
        versions: versions.slice(0, 5).map((v) => `${v.version} ${v.state}`),
        shown_version: version && `${version.version} ${version.state}`,
      };
      if (!version) return out;
      const locs = await client.versionLocalizations(version.id);
      out.localizations = await pool(locs, 4, async (l, i) => {
        ctx.progress(`Reading ${l.locale}`, i, locs.length);
        const sets = await client.screenshotSets(l.id);
        const counts = {};
        for (const s of sets) counts[s.displayType] = (await client.screenshots(s.id)).length;
        return { locale: l.locale, screenshots: counts, has_description: !!l.description };
      });
      const info = await client.appInfo(a.id);
      if (info) {
        const infoLocs = await client.appInfoLocalizations(info.id);
        out.app_info = {
          state: info.state,
          name_and_subtitle_editable: info.editable,
          locales: infoLocs.map((l) => `${l.locale}: ${l.name}${l.subtitle ? ` | ${l.subtitle}` : ''}`),
        };
      }
      return out;
    },
  },

  {
    name: 'asc_metadata_get',
    description:
      'Reads the store text for each locale: name, subtitle, description, keywords, promotional text, what\'s new and URLs.',
    inputSchema: {
      type: 'object',
      required: ['app'],
      properties: {
        account: S.account,
        app: S.app,
        platform: S.platform,
        locales: S.locales,
        fields: {
          type: 'array',
          items: { type: 'string', enum: [...Object.keys(INFO_FIELDS), ...Object.keys(VERSION_FIELDS)] },
          description: 'Only these fields; long descriptions for many locales are large',
        },
      },
    },
    async run({ account, app, platform = 'IOS', locales, fields }) {
      const { client, app: a } = await ascForApp(app, account);
      const version = await ascVersion(client, a.id, platform, { editable: false });
      const locs = pickLocales(await client.versionLocalizations(version.id), locales, 'locale');
      const want = (k) => !fields?.length || fields.includes(k);
      const info = await client.appInfo(a.id);
      const infoLocs = info ? await client.appInfoLocalizations(info.id) : [];
      return {
        app: `${a.name} (${a.bundleId})`,
        version: `${version.version} ${version.state}`,
        locales: locs.map((l) => {
          const i = infoLocs.find((x) => x.locale === l.locale) ?? {};
          const row = { locale: l.locale };
          for (const [k, attr] of Object.entries(INFO_FIELDS)) if (want(k)) row[k] = i[attr] ?? null;
          for (const [k, attr] of Object.entries(VERSION_FIELDS)) if (want(k)) row[k] = l[attr] ?? null;
          return row;
        }),
      };
    },
  },

  {
    name: 'asc_metadata_update',
    description:
      'Changes store text per locale. Version text (description, keywords, what\'s new, URLs) needs a version in Prepare for Submission; name and subtitle need an editable app info. Promotional text sent on its own changes the live version, so it shows on the store right away; sent with other version text it goes to the version being prepared. The dry run names the version. Dry run by default.',
    inputSchema: {
      type: 'object',
      required: ['app', 'changes'],
      properties: {
        account: S.account,
        app: S.app,
        platform: S.platform,
        changes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['locale'],
            properties: {
              locale: { type: 'string' },
              ...Object.fromEntries([...Object.keys(INFO_FIELDS), ...Object.keys(VERSION_FIELDS)].map((k) => [k, { type: 'string' }])),
            },
          },
        },
        create_missing_locales: { type: 'boolean', default: false },
        dry_run: S.dryRun,
      },
    },
    async run({ account, app, platform = 'IOS', changes, create_missing_locales = false, dry_run = true }) {
      const errors = limitErrors(changes, ASC_LIMITS, 'locale');
      if (errors.length) throw new StoreError('Text is over the App Store limits', errors);
      const { client, app: a } = await ascForApp(app, account);
      const needsVersion = changes.some((c) =>
        Object.keys(VERSION_FIELDS).some((k) => k !== 'promotional_text' && c[k] != null),
      );
      // Promotional text alone changes on the store at once: the live version.
      const version = needsVersion
        ? await client.editableVersion(a.id, platform)
        : await ascVersion(client, a.id, platform, { editable: false, live: true });
      const locs = await client.versionLocalizations(version.id);
      const needsInfo = changes.some((c) => Object.keys(INFO_FIELDS).some((k) => c[k] != null));
      const info = needsInfo ? await client.appInfo(a.id) : null;
      if (needsInfo && !info?.editable) {
        throw new StoreError('Name, subtitle and privacy URLs can only change while a new version is being prepared');
      }
      const infoLocs = info ? await client.appInfoLocalizations(info.id) : [];

      const plan = [];
      for (const c of changes) {
        const loc = locs.find((l) => l.locale === c.locale);
        const iloc = infoLocs.find((l) => l.locale === c.locale);
        const step = { locale: c.locale, fields: [], version: {}, info: {} };
        if (!loc && !create_missing_locales) {
          step.skipped = `${c.locale} is not on version ${version.version}; set create_missing_locales to add it`;
          plan.push(step);
          continue;
        }
        if (!loc) step.create = true;
        for (const [k, attr] of Object.entries(VERSION_FIELDS)) {
          if (c[k] == null || loc?.[attr] === c[k]) continue;
          step.version[attr] = c[k];
          step.fields.push({ field: k, from: preview(loc?.[attr]), to: preview(c[k]), chars: charCount(c[k]) });
        }
        for (const [k, attr] of Object.entries(INFO_FIELDS)) {
          if (c[k] == null || iloc?.[attr] === c[k]) continue;
          step.info[attr] = c[k];
          step.fields.push({ field: k, from: preview(iloc?.[attr]), to: preview(c[k]), chars: charCount(c[k]) });
        }
        step.loc = loc;
        step.iloc = iloc;
        plan.push(step);
      }
      const report = plan.map(({ locale, fields, create, skipped }) => ({
        locale,
        ...(create && { create_locale: true }),
        ...(skipped ? { skipped } : { changes: fields.length ? fields : 'no change' }),
      }));
      const head = {
        app: `${a.name} (${a.bundleId})`,
        version: `${version.version} ${version.state}${ASC_LIVE.has(version.state) ? ' (live on the store; changes show right away)' : ''}`,
      };
      if (dry_run) return { ...head, plan: report, note: CONFIRM };

      const done = [];
      for (const s of plan) {
        if (s.skipped || !s.fields.length) continue;
        try {
          if (s.loc) {
            if (Object.keys(s.version).length) await client.updateVersionLocalization(s.loc.id, s.version);
          } else {
            await client.createVersionLocalization(version.id, s.locale, s.version);
          }
          if (Object.keys(s.info).length) {
            if (s.iloc) await client.updateAppInfoLocalization(s.iloc.id, s.info);
            else await client.createAppInfoLocalization(info.id, s.locale, s.info);
          }
          done.push({ locale: s.locale, updated: s.fields.map((f) => f.field) });
        } catch (err) {
          done.push({ locale: s.locale, error: [err.message, ...(err.details ?? [])].join(' ') });
        }
      }
      return { ...head, result: done };
    },
  },

  {
    name: 'asc_screenshots_push',
    description:
      'Replaces App Store screenshots from a local folder (<dir>/<locale>/<folder>/*.png) on the version being prepared. Only the display types present locally are touched; each is emptied and refilled in file-name order. Dry run by default. Large sets: send a few locales per call.',
    inputSchema: {
      type: 'object',
      required: ['app', 'dir'],
      properties: {
        account: S.account,
        app: S.app,
        dir: { type: 'string', description: 'Absolute path to the folder that holds the locale folders' },
        platform: S.platform,
        locales: S.locales,
        devices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these device folders or display types, e.g. ["iphone-6.5", "APP_IPAD_PRO_3GEN_129"]',
        },
        create_missing_locales: { type: 'boolean', default: false },
        dry_run: S.dryRun,
      },
    },
    async run({ account, app, dir, platform = 'IOS', locales, devices, create_missing_locales = false, dry_run = true }, ctx) {
      const scan = await scanAsc(dir, { locales, devices });
      if (scan.errors.length) throw new StoreError('The local screenshots have problems; nothing was sent', scan.errors);
      const { client, app: a } = await ascForApp(app, account);
      const version = await client.editableVersion(a.id, platform);
      const remote = await client.versionLocalizations(version.id);

      const plan = [];
      for (const l of scan.locales) {
        const loc = remote.find((r) => r.locale === l.locale);
        if (!loc && !create_missing_locales) {
          plan.push({ locale: l.locale, skipped: `not on version ${version.version}; set create_missing_locales to add it` });
          continue;
        }
        const sets = loc ? await client.screenshotSets(loc.id) : [];
        for (const s of l.sets) {
          const rset = sets.find((x) => x.displayType === s.displayType);
          const existing = rset ? await client.screenshots(rset.id) : [];
          plan.push({ locale: l.locale, loc, rset, set: s, existing });
        }
      }
      const head = {
        app: `${a.name} (${a.bundleId})`,
        version: `${version.version} ${version.state}${ASC_LIVE.has(version.state) ? ' (live on the store; changes show right away)' : ''}`,
      };
      const report = plan.map((p) =>
        p.skipped
          ? { locale: p.locale, skipped: p.skipped }
          : {
              locale: p.locale,
              display_type: `${p.set.displayType} (${ASC_DISPLAY_TYPES[p.set.displayType].label})`,
              from: p.set.folder,
              replace: `${p.existing.length} -> ${p.set.files.length}`,
              ...(!p.loc && { create_locale: true }),
            },
      );
      if (dry_run) return { ...head, plan: report, note: CONFIRM };

      const created = new Map();
      const results = [];
      const work = plan.filter((p) => !p.skipped);
      for (const [i, p] of work.entries()) {
        const label = `${p.locale} ${p.set.displayType}`;
        ctx.progress(`Uploading ${label}`, i, work.length);
        try {
          let loc = p.loc ?? created.get(p.locale);
          if (!loc) {
            loc = await client.createVersionLocalization(version.id, p.locale);
            created.set(p.locale, loc);
          }
          const rset = p.rset ?? (await client.createScreenshotSet(loc.id, p.set.displayType));
          await pool(p.existing, 4, (s) => client.deleteScreenshot(s.id));
          const ids = await pool(p.set.files, 3, (f) => client.uploadScreenshot(rset.id, f));
          const processed = await client.waitProcessed(ids);
          await client.reorder(rset.id, ids);
          results.push({
            set: label,
            uploaded: ids.length,
            ...(processed.failed.length && { failed: processed.failed }),
            ...(processed.stillProcessing && { still_processing: processed.stillProcessing }),
          });
        } catch (err) {
          results.push({ set: label, error: [err.message, ...(err.details ?? [])].join(' ') });
        }
      }
      return { ...head, result: results, skipped: report.filter((r) => r.skipped) };
    },
  },

  {
    name: 'asc_screenshots_pull',
    description:
      'Downloads the current App Store screenshots to <out_dir>/<locale>/<DISPLAY_TYPE>/NN.png in store order, so they can be reviewed or edited.',
    inputSchema: {
      type: 'object',
      required: ['app', 'out_dir'],
      properties: { account: S.account, app: S.app, out_dir: { type: 'string' }, platform: S.platform, locales: S.locales },
    },
    async run({ account, app, out_dir, platform = 'IOS', locales }, ctx) {
      const { client, app: a } = await ascForApp(app, account);
      const version = await ascVersion(client, a.id, platform, { editable: false });
      const locs = pickLocales(await client.versionLocalizations(version.id), locales, 'locale');
      const root = resolve(out_dir);
      let count = 0;
      for (const [i, l] of locs.entries()) {
        ctx.progress(`Downloading ${l.locale}`, i, locs.length);
        for (const set of await client.screenshotSets(l.id)) {
          const shots = await client.screenshots(set.id);
          const dir = join(root, l.locale, set.displayType);
          await mkdir(dir, { recursive: true });
          await pool(shots, 4, async (s, n) => {
            const url = imageUrl(s.imageAsset);
            if (!url) return;
            await download(url, join(dir, String(n + 1).padStart(2, '0')), ['mzstatic.com', 'apple.com']);
            count++;
          });
        }
      }
      return { app: `${a.name} (${a.bundleId})`, version: `${version.version} ${version.state}`, saved: count, dir: root };
    },
  },

  {
    name: 'asc_version_create',
    description: 'Creates a new App Store version (Prepare for Submission) so screenshots and text can be edited. Dry run by default.',
    inputSchema: {
      type: 'object',
      required: ['app', 'version'],
      properties: { account: S.account, app: S.app, version: { type: 'string', description: 'e.g. 1.2.0' }, platform: S.platform, dry_run: S.dryRun },
    },
    async run({ account, app, version, platform = 'IOS', dry_run = true }) {
      const { client, app: a } = await ascForApp(app, account);
      const existing = await client.versions(a.id, platform);
      if (dry_run) {
        return {
          app: `${a.name} (${a.bundleId})`,
          would_create: `${platform} ${version}`,
          latest: existing.slice(0, 3).map((v) => `${v.version} ${v.state}`),
          note: CONFIRM,
        };
      }
      const { data } = await client.createVersion(a.id, platform, version);
      return { created: `${platform} ${data.attributes.versionString}`, state: data.attributes.appVersionState ?? data.attributes.appStoreState };
    },
  },

  // ------------------------------------------------------------ Google Play

  {
    name: 'play_status',
    description: 'Shows the Play store listing languages and how many images each has per type.',
    inputSchema: { type: 'object', required: ['package'], properties: { account: S.account, package: S.pkg } },
    async run({ account, package: pkg }, ctx) {
      const { client } = await playForPackage(pkg, account);
      return client.withEdit(pkg, async (edit) => {
        const listings = await client.listings(pkg, edit);
        const rows = await pool(listings, 3, async (l, i) => {
          ctx.progress(`Reading ${l.language}`, i, listings.length);
          const images = {};
          for (const type of ['phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'featureGraphic']) {
            images[type] = (await client.images(pkg, edit, l.language, type)).length;
          }
          return { language: l.language, title: l.title, images };
        });
        return { package: pkg, listings: rows };
      });
    },
  },

  {
    name: 'play_listing_get',
    description: 'Reads the Play store listing text (title, short and full description, video) per language.',
    inputSchema: {
      type: 'object',
      required: ['package'],
      properties: {
        account: S.account,
        package: S.pkg,
        languages: S.languages,
        fields: {
          type: 'array',
          items: { type: 'string', enum: Object.keys(LISTING_FIELDS) },
          description: 'Only these fields; full descriptions for many languages are large',
        },
      },
    },
    async run({ account, package: pkg, languages, fields }) {
      const { client } = await playForPackage(pkg, account);
      const want = (k) => !fields?.length || fields.includes(k);
      return client.withEdit(pkg, async (edit) => ({
        package: pkg,
        listings: pickLocales(await client.listings(pkg, edit), languages, 'language').map((l) => {
          const row = { language: l.language };
          for (const [k, attr] of Object.entries(LISTING_FIELDS)) if (want(k)) row[k] = l[attr] || null;
          return row;
        }),
      }));
    },
  },

  {
    name: 'play_listing_update',
    description:
      'Changes Play listing text per language in one edit. A new language needs title, short_description and full_description. Dry run by default.',
    inputSchema: {
      type: 'object',
      required: ['package', 'changes'],
      properties: {
        account: S.account,
        package: S.pkg,
        changes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['language'],
            properties: {
              language: { type: 'string' },
              ...Object.fromEntries(Object.keys(LISTING_FIELDS).map((k) => [k, { type: 'string' }])),
            },
          },
        },
        dry_run: S.dryRun,
        send_for_review: S.sendForReview,
      },
    },
    async run({ account, package: pkg, changes, dry_run = true, send_for_review = false }) {
      const errors = limitErrors(changes, PLAY_LIMITS, 'language');
      if (errors.length) throw new StoreError('Text is over the Play limits', errors);
      const { client } = await playForPackage(pkg, account);
      return client.withEdit(
        pkg,
        async (edit) => {
          const plan = [];
          for (const c of changes) {
            const current = await client.listing(pkg, edit, c.language);
            const next = { ...(current ?? {}) };
            const fields = [];
            for (const [k, attr] of Object.entries(LISTING_FIELDS)) {
              if (c[k] == null || current?.[attr] === c[k]) continue;
              next[attr] = c[k];
              fields.push({ field: k, from: preview(current?.[attr]), to: preview(c[k]), chars: charCount(c[k]) });
            }
            if (!current && !(next.title && next.shortDescription && next.fullDescription)) {
              throw new StoreError(`${c.language} is a new language; give title, short_description and full_description`);
            }
            plan.push({ language: c.language, new_language: !current, fields, next });
          }
          if (!dry_run) {
            for (const p of plan) if (p.fields.length) await client.putListing(pkg, edit, p.language, p.next);
          }
          return {
            package: pkg,
            [dry_run ? 'plan' : 'updated']: plan.map((p) => ({
              language: p.language,
              ...(p.new_language && { new_language: true }),
              changes: p.fields.length ? p.fields : 'no change',
            })),
            ...(dry_run ? { note: CONFIRM } : { review: send_for_review ? 'sent for review' : 'waiting in Play Console until you send it for review' }),
          };
        },
        { commit: !dry_run, sendForReview: send_for_review },
      );
    },
  },

  {
    name: 'play_screenshots_push',
    description:
      'Replaces Play store images from a local folder (<dir>/<language>/<phone|tablet-7|tablet|tv|wear|feature-graphic>/*.png) in one edit: all or nothing. Only the types present locally are touched. Dry run by default.',
    inputSchema: {
      type: 'object',
      required: ['package', 'dir'],
      properties: {
        account: S.account,
        package: S.pkg,
        dir: { type: 'string', description: 'Absolute path to the folder that holds the language folders' },
        languages: S.languages,
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these folders or image types, e.g. ["phone", "tenInchScreenshots"]',
        },
        dry_run: S.dryRun,
        send_for_review: S.sendForReview,
      },
    },
    async run({ account, package: pkg, dir, languages, types, dry_run = true, send_for_review = false }, ctx) {
      const scan = await scanPlay(dir, { languages, types });
      if (scan.errors.length) throw new StoreError('The local images have problems; nothing was sent', scan.errors);
      const { client } = await playForPackage(pkg, account);
      return client.withEdit(
        pkg,
        async (edit) => {
          const existing = new Set((await client.listings(pkg, edit)).map((l) => l.language));
          const plan = [];
          for (const l of scan.languages) {
            if (!existing.has(l.language)) {
              plan.push({ language: l.language, skipped: 'no store listing in this language; add its text with play_listing_update first' });
              continue;
            }
            for (const s of l.sets) {
              const current = await client.images(pkg, edit, l.language, s.imageType);
              plan.push({ language: l.language, set: s, current: current.length });
            }
          }
          const report = plan.map((p) =>
            p.skipped
              ? { language: p.language, skipped: p.skipped }
              : {
                  language: p.language,
                  type: `${p.set.imageType} (${PLAY_IMAGE_TYPES[p.set.imageType].label})`,
                  from: p.set.folder,
                  replace: `${p.current} -> ${p.set.files.length}`,
                },
          );
          if (dry_run) return { package: pkg, plan: report, warnings: scan.warnings, note: CONFIRM };
          const work = plan.filter((p) => !p.skipped);
          for (const [i, p] of work.entries()) {
            ctx.progress(`Uploading ${p.language} ${p.set.imageType}`, i, work.length);
            await client.deleteAllImages(pkg, edit, p.language, p.set.imageType);
            for (const f of p.set.files) {
              await client.uploadImage(pkg, edit, p.language, p.set.imageType, await readFile(f.path), contentType(f.info.format));
            }
          }
          return {
            package: pkg,
            uploaded: report.filter((r) => !r.skipped),
            skipped: report.filter((r) => r.skipped),
            review: send_for_review ? 'sent for review' : 'waiting in Play Console until you send it for review',
          };
        },
        { commit: !dry_run, sendForReview: send_for_review },
      );
    },
  },

  {
    name: 'asc_ipa_upload',
    description:
      'Uploads an iOS .ipa with Xcode altool (xcrun). macOS only: on any other system it stops and says so. Uses the configured App Store Connect key, so the same plugin options work on every Mac that has Xcode. Dry run by default. Apple rejects a build number that was already uploaded.',
    inputSchema: {
      type: 'object',
      required: ['ipa'],
      properties: {
        account: S.account,
        ipa: { type: 'string', description: 'Absolute path to the .ipa file' },
        dry_run: S.dryRun,
      },
    },
    async run({ account, ipa, dry_run = true }) {
      return uploadIpa(ipa, { dryRun: dry_run, account });
    },
  },

  {
    name: 'play_bundle_upload',
    description:
      "Uploads an Android App Bundle (.aab) and puts it on a release track in one edit. Dry run by default: the bundle goes into a temporary edit, Google checks its signing, version code and the release as a commit would, then the edit is thrown away. A real run commits the release; on production that means review and then users. rollout below 1 makes a staged rollout; draft leaves the release to finish in Play Console.",
    inputSchema: {
      type: 'object',
      required: ['package', 'aab'],
      properties: {
        account: S.account,
        package: S.pkg,
        aab: { type: 'string', description: 'Absolute path to the .aab file' },
        track: {
          type: 'string',
          default: 'internal',
          description: 'internal, alpha (closed testing), beta (open testing), production, or a custom track',
        },
        rollout: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 1,
          default: 1,
          description: 'Share of users, e.g. 0.2 for a 20% staged rollout; 1 releases to everyone',
        },
        draft: { type: 'boolean', default: false, description: 'Create a draft release to finish in Play Console' },
        release_name: { type: 'string', description: "Defaults to Play's own name for the version" },
        release_notes: {
          type: 'array',
          description: "What's new per Play language, 500 characters each",
          items: {
            type: 'object',
            required: ['language', 'text'],
            properties: { language: { type: 'string' }, text: { type: 'string' } },
          },
        },
        dry_run: S.dryRun,
        send_for_review: S.sendForReview,
      },
    },
    async run(
      {
        account,
        package: pkg,
        aab,
        track = 'internal',
        rollout = 1,
        draft = false,
        release_name,
        release_notes = [],
        dry_run = true,
        send_for_review = false,
      },
      ctx,
    ) {
      if (!isAbsolute(aab) || !aab.toLowerCase().endsWith('.aab')) {
        throw new StoreError('aab must be an absolute path to an .aab file');
      }
      if (!(await stat(aab).catch(() => null))?.isFile()) throw new StoreError(`No file at ${aab}`);
      if (!(rollout > 0 && rollout <= 1)) throw new StoreError('rollout must be above 0 and at most 1');
      const long = release_notes
        .filter((n) => charCount(n.text) > 500)
        .map((n) => `${n.language}: ${charCount(n.text)} characters, limit is 500`);
      if (long.length) throw new StoreError('Release notes are over the Play limit', long);

      const status = draft ? 'draft' : rollout < 1 ? 'inProgress' : 'completed';
      const bytes = await readFile(aab);
      const size = `${(bytes.length / 1048576).toFixed(1)} MB`;
      const { client } = await playForPackage(pkg, account);
      return client.withEdit(
        pkg,
        async (edit) => {
          const before = (await client.tracks(pkg, edit)).find((t) => t.track === track);
          ctx.progress(`Uploading ${size} to Google Play`, 0, 3);
          const { versionCode } = await client.uploadBundle(pkg, edit, bytes);
          const release = {
            ...(release_name && { name: release_name }),
            versionCodes: [String(versionCode)],
            status,
            ...(status === 'inProgress' && { userFraction: rollout }),
            ...(release_notes.length && { releaseNotes: release_notes.map(({ language, text }) => ({ language, text })) }),
          };
          ctx.progress(`Putting ${versionCode} on ${track}`, 1, 3);
          await client.putTrack(pkg, edit, track, [release]);
          const plan = {
            package: pkg,
            bundle: `${aab} (${size}), version code ${versionCode}`,
            track,
            on_track_now: (before?.releases ?? []).map(
              (r) => `${r.name ?? r.versionCodes?.join(',')} ${r.status}${r.userFraction ? ` ${r.userFraction * 100}%` : ''}`,
            ),
            new_release: `${status}${status === 'inProgress' ? ` to ${rollout * 100}% of users` : ''}, notes in ${release_notes.length} languages`,
          };
          if (!dry_run) {
            return {
              ...plan,
              done: true,
              review: draft
                ? 'draft release; finish it in Play Console'
                : send_for_review
                  ? 'sent for review'
                  : 'waiting in Play Console until you send it for review',
            };
          }
          ctx.progress('Validating the edit', 2, 3);
          await client.validateEdit(pkg, edit);
          return {
            ...plan,
            validated: 'Google accepted the bundle and the release in a temporary edit, which was thrown away.',
            note: CONFIRM,
          };
        },
        { commit: !dry_run, sendForReview: send_for_review },
      );
    },
  },

  {
    name: 'play_screenshots_pull',
    description:
      'Downloads the current Play store images to <out_dir>/<language>/<imageType>/NN.<png|jpg> so they can be reviewed or edited.',
    inputSchema: {
      type: 'object',
      required: ['package', 'out_dir'],
      properties: { account: S.account, package: S.pkg, out_dir: { type: 'string' }, languages: S.languages },
    },
    async run({ account, package: pkg, out_dir, languages }, ctx) {
      const { client } = await playForPackage(pkg, account);
      const root = resolve(out_dir);
      let count = 0;
      await client.withEdit(pkg, async (edit) => {
        const listings = pickLocales(await client.listings(pkg, edit), languages, 'language');
        for (const [i, l] of listings.entries()) {
          ctx.progress(`Downloading ${l.language}`, i, listings.length);
          for (const type of Object.keys(PLAY_IMAGE_TYPES)) {
            const images = await client.images(pkg, edit, l.language, type);
            if (!images.length) continue;
            const dir = join(root, l.language, type);
            await mkdir(dir, { recursive: true });
            await pool(images, 4, async (img, n) => {
              // Swap any size suffix for "=s0", the original size.
              const url = `${img.url.replace(/=[^/]*$/, '')}=s0`;
              await download(url, join(dir, String(n + 1).padStart(2, '0')), ['googleusercontent.com', 'ggpht.com']);
              count++;
            });
          }
        }
      });
      return { package: pkg, saved: count, dir: root };
    },
  },
];
