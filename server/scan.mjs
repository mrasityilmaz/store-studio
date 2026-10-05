import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { imageInfo } from './image.mjs';
import {
  ASC_DISPLAY_TYPES,
  ASC_MAX_PER_SET,
  PLAY_IMAGE_TYPES,
  ascResolveDisplayType,
  playImageCheck,
  playResolveImageType,
} from './specs.mjs';
import { StoreError, naturalSort } from './util.mjs';

const IMAGE_EXT = /\.(png|jpe?g)$/i;

async function subdirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort(naturalSort);
}

async function images(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile() && IMAGE_EXT.test(e.name)).map((e) => e.name);
  names.sort(naturalSort);
  return Promise.all(
    names.map(async (name) => ({ name, path: join(dir, name), info: await imageInfo(join(dir, name)) })),
  );
}

async function rootDir(dir) {
  const root = resolve(dir);
  const s = await stat(root).catch(() => null);
  if (!s?.isDirectory()) throw new StoreError(`Not a directory: ${root}`);
  return root;
}

const pick = (list, wanted) => !wanted?.length || wanted.some((w) => w.toLowerCase() === list.toLowerCase());

// Layout: <dir>/<locale>/<folder>/<images>. The folder is either a display
// type name (APP_IPHONE_67) or any label; the pixel size decides the type.
export async function scanAsc(dir, { locales, devices } = {}) {
  const root = await rootDir(dir);
  const out = { root, locales: [], errors: [], warnings: [] };
  for (const locale of await subdirs(root)) {
    if (!pick(locale, locales)) continue;
    const loc = { locale, sets: [] };
    for (const folder of await subdirs(join(root, locale))) {
      const files = await images(join(root, locale, folder));
      if (!files.length) continue;
      const set = { folder, displayType: null, files, errors: [], warnings: [] };
      const types = new Set();
      for (const f of files) {
        const { format, width, height, alpha } = f.info;
        if (!['png', 'jpeg'].includes(format)) set.errors.push(`${f.name}: must be PNG or JPEG`);
        if (alpha) set.errors.push(`${f.name}: has an alpha channel (App Store rejects transparency)`);
        if (!width) continue;
        const r = ascResolveDisplayType(folder, width, height);
        if (r.error) set.errors.push(`${f.name}: ${r.error}`);
        else types.add(r.type);
      }
      if (types.size > 1) set.errors.push(`images map to different display types: ${[...types].join(', ')}`);
      set.displayType = types.size === 1 ? [...types][0] : null;
      if (files.length > ASC_MAX_PER_SET) set.errors.push(`${files.length} images; App Store allows ${ASC_MAX_PER_SET}`);
      if (!pick(folder, devices) && !pick(set.displayType ?? '', devices)) continue;
      loc.sets.push(set);
    }
    // Two folders can't fill the same slot.
    const seen = new Map();
    for (const set of loc.sets) {
      if (!set.displayType) continue;
      const prev = seen.get(set.displayType);
      if (prev) {
        set.errors.push(
          `"${prev}" and "${set.folder}" both map to ${set.displayType} (${ASC_DISPLAY_TYPES[set.displayType].label}); keep one or pass devices`,
        );
      }
      seen.set(set.displayType, set.folder);
    }
    if (loc.sets.length) out.locales.push(loc);
  }
  if (!out.locales.length) out.errors.push(`No images found under ${root}/<locale>/<folder>/`);
  for (const l of out.locales) for (const s of l.sets) for (const e of s.errors) out.errors.push(`${l.locale}/${s.folder}: ${e}`);
  return out;
}

// Layout: <dir>/<language>/<folder>/<images>, where the folder is phone,
// tablet-7, tablet (10"), tv, wear, feature-graphic or a Play image type.
export async function scanPlay(dir, { languages, types } = {}) {
  const root = await rootDir(dir);
  const out = { root, languages: [], errors: [], warnings: [] };
  for (const language of await subdirs(root)) {
    if (!pick(language, languages)) continue;
    const lang = { language, sets: [] };
    for (const folder of await subdirs(join(root, language))) {
      const files = await images(join(root, language, folder));
      if (!files.length) continue;
      const imageType = playResolveImageType(folder);
      const set = { folder, imageType, files, errors: [], warnings: [] };
      if (!imageType) {
        set.errors.push(`unknown folder; use one of ${Object.values(PLAY_IMAGE_TYPES).flatMap((t) => t.aliases).join(', ')}`);
      } else {
        if (!pick(folder, types) && !pick(imageType, types)) continue;
        for (const f of files) {
          const { errors, warnings } = playImageCheck(imageType, f.info);
          for (const e of errors) set.errors.push(`${f.name}: ${e}`);
          for (const w of warnings) set.warnings.push(`${f.name}: ${w}`);
        }
        const max = PLAY_IMAGE_TYPES[imageType].max;
        if (files.length > max) set.errors.push(`${files.length} images; Play allows ${max}`);
        if (imageType !== 'featureGraphic' && files.length < 4) {
          set.warnings.push('Play recommends at least 4 screenshots per device type');
        }
      }
      lang.sets.push(set);
    }
    const seen = new Map();
    for (const set of lang.sets) {
      if (!set.imageType) continue;
      if (seen.has(set.imageType)) {
        set.errors.push(`"${seen.get(set.imageType)}" and "${set.folder}" both map to ${set.imageType}`);
      }
      seen.set(set.imageType, set.folder);
    }
    if (lang.sets.length) out.languages.push(lang);
  }
  if (!out.languages.length) out.errors.push(`No images found under ${root}/<language>/<folder>/`);
  for (const l of out.languages) {
    for (const s of l.sets) {
      for (const e of s.errors) out.errors.push(`${l.language}/${s.folder}: ${e}`);
      for (const w of s.warnings) out.warnings.push(`${l.language}/${s.folder}: ${w}`);
    }
  }
  return out;
}

// Compact view for tool output.
export const describeFiles = (files) =>
  files.map((f) => `${f.name} ${f.info.width}x${f.info.height}`);
