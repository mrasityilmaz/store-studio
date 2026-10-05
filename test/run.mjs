// node test/run.mjs — validation rules plus the mock store flows.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTree } from './fixtures.mjs';
import { imageInfo } from '../server/image.mjs';
import { explainAltool, macOnlyReason } from '../server/ipa.mjs';
import { scanAsc, scanPlay } from '../server/scan.mjs';

// Tests never read the real accounts file.
process.env.STORE_STUDIO_ACCOUNTS = join(mkdtempSync(join(tmpdir(), 'store-studio-noacc-')), 'accounts.json');

const tmp = mkdtempSync(join(tmpdir(), 'store-studio-scan-'));
makeTree(tmp, {
  ios: {
    'en-US': { 'iphone-a': [1320, 2868, 3], 'iphone-b': [1284, 2778, 3], 'iphone-c': [1242, 2688, 2], ipad: [2048, 2732, 2] },
    de: { APP_IPAD_PRO_129: [2048, 2732, 1], broken: [1000, 2000, 1], alpha: [1290, 2796, 1, { alpha: true }] },
  },
  play: {
    'en-US': { phone: [1080, 1920, 4], tablet: [1440, 2560, 4], 'feature-graphic': [1024, 500, 1] },
    'de-DE': { phone: [1080, 2400, 2], tablet: [1200, 1920, 1], odd: [1080, 1920, 1] },
  },
});

const info = await imageInfo(join(tmp, 'ios/de/alpha/01_shot.png'));
assert.deepEqual([info.format, info.width, info.height, info.alpha], ['png', 1290, 2796, true]);

let a = await scanAsc(join(tmp, 'ios'));
const types = Object.fromEntries(a.locales[1].sets.map((s) => [s.folder, s.displayType]));
assert.equal(types['iphone-a'], 'APP_IPHONE_67');
assert.equal(types['iphone-b'], 'APP_IPHONE_65');
assert.equal(types.ipad, 'APP_IPAD_PRO_3GEN_129', '2048x2732 defaults to the 13" slot');
assert.ok(a.errors.some((e) => /both map to APP_IPHONE_65/.test(e)), 'duplicate slot');
assert.ok(a.errors.some((e) => /broken.*not an App Store screenshot size/.test(e)));
assert.ok(a.errors.some((e) => /alpha channel/.test(e)));
assert.equal(a.locales[0].sets.find((s) => s.folder === 'APP_IPAD_PRO_129').displayType, 'APP_IPAD_PRO_129', 'folder name wins');

a = await scanAsc(join(tmp, 'ios'), { locales: ['en-US'], devices: ['iphone-a', 'iphone-b', 'ipad'] });
assert.deepEqual(a.errors, [], 'filters resolve the duplicate');

const p = await scanPlay(join(tmp, 'play'));
const en = p.languages.find((l) => l.language === 'en-US');
assert.deepEqual(en.sets.map((s) => s.imageType).sort(), ['featureGraphic', 'phoneScreenshots', 'tenInchScreenshots']);
assert.ok(p.errors.some((e) => /de-DE\/phone.*twice the short side/.test(e)), '1080x2400 breaks the 2:1 rule');
assert.ok(p.errors.some((e) => /de-DE\/odd: unknown folder/.test(e)));
assert.ok(p.warnings.some((w) => /de-DE\/tablet.*9:16/.test(w)));
assert.ok(!p.errors.some((e) => e.startsWith('en-US')));
assert.equal(macOnlyReason('darwin'), null);
assert.match(macOnlyReason('linux'), /only runs on a Mac/);
assert.match(macOnlyReason('win32'), /win32/);
const duplicate = explainAltool(`
ERROR: The bundle version must be higher than the previously uploaded version: ‘50’.
      detail : The bundle version must be higher than the previously uploaded version.
         pointer : /data/attributes/cfBundleVersion
      code : ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE
         previousBundleVersion : 50
   iris-code : ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE
`);
assert.equal(duplicate.code, 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE');
assert.match(duplicate.message, /Build 50 is already on App Store Connect/);
const unknown = explainAltool('detail : Something else went wrong.\n   iris-code : ENTITY_ERROR.UNKNOWN');
assert.equal(unknown.message, 'Something else went wrong.');
console.log('validation checks passed');

await import('./mock-stores.mjs');
await import('./api-tools.mjs');
await import('./hardening.mjs');
await import('./accounts.mjs');
await import('./account-add.mjs');
