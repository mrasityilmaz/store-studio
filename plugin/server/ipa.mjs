// Uploads an IPA with Xcode's altool. That binary exists only on a Mac.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { accounts, ascForApp } from './clients.mjs';
import { StoreError, pemKey, setupHint } from './util.mjs';

const exec = promisify(execFile);

// `platform` is injected in tests. Production calls use the real OS.
export function macOnlyReason(platform = process.platform) {
  if (platform === 'darwin') return null;
  return `IPA upload uses Xcode's altool and only runs on a Mac. This computer is ${platform}.`;
}

async function xcrun() {
  const reason = macOnlyReason();
  if (reason) throw new StoreError(reason);
  const path = '/usr/bin/xcrun';
  try {
    await access(path);
  } catch {
    throw new StoreError('xcrun was not found. Install Xcode on this Mac, then try again.');
  }
  return path;
}

// The account that can see the app inside the IPA, with its key.
async function credentials(bundleId, account) {
  const { account: name } = await ascForApp(bundleId, account);
  const { keyId, issuerId, privateKey, keyPath } = accounts().asc[name];
  const missing = [!keyId && 'key ID', !issuerId && 'issuer ID', !privateKey && !keyPath && 'private key'].filter(Boolean);
  if (missing.length) {
    throw new StoreError(`App Store Connect account "${name}" is missing its ${missing.join(', ')}. ${setupHint()}`);
  }
  return { account: name, keyId, issuerId, privateKey, keyPath };
}

// altool only reads keys from files. An account connected in the chat already
// has one; for a key from the plugin settings, a copy goes into a fresh folder
// only this user can open and is deleted as soon as altool exits.
async function withKeyFile(creds, fn) {
  if (creds.keyPath) return fn(creds.keyPath);
  const dir = await mkdtemp(join(tmpdir(), 'store-studio-'));
  try {
    const file = join(dir, `AuthKey_${creds.keyId}.p8`);
    await writeFile(file, pemKey(creds.privateKey, `The App Store Connect private key for key ID ${creds.keyId}`), { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Payload/*.app/Info.plist, whichever app is inside the archive.
async function infoPlistEntry(ipa) {
  const { stdout } = await exec('unzip', ['-Z1', ipa], { maxBuffer: 8_000_000 });
  const entry = stdout.split('\n').find((line) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(line));
  if (!entry) throw new StoreError('The IPA has no Payload/*.app/Info.plist.');
  return entry;
}

async function plistValue(file, key) {
  const { stdout } = await exec('plutil', ['-extract', key, 'raw', '-o', '-', file]);
  return stdout.trim();
}

// Reads the bundle id and version without uploading.
export async function readIpa(ipa) {
  const path = resolve(ipa);
  try {
    await access(path);
  } catch {
    throw new StoreError(`No IPA at ${path}`);
  }
  if (!path.toLowerCase().endsWith('.ipa')) throw new StoreError(`${path} is not an .ipa file`);
  const entry = await infoPlistEntry(path);
  const { stdout } = await exec('unzip', ['-p', path, entry], { encoding: 'buffer', maxBuffer: 4_000_000 });
  const dir = await mkdtemp(join(tmpdir(), 'store-studio-ipa-'));
  const plist = join(dir, 'Info.plist');
  try {
    await writeFile(plist, stdout);
    const [bundleId, version, build] = await Promise.all([
      plistValue(plist, 'CFBundleIdentifier'),
      plistValue(plist, 'CFBundleShortVersionString'),
      plistValue(plist, 'CFBundleVersion'),
    ]);
    return { path, bundle_id: bundleId, version, build };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// altool looks for AuthKey_<id>.p8 in a few fixed folders; naming the key
// file on the command line works on every Mac.
// Apple reuses one iris code for many fields. The pointer says which field.
const ALTOOL_HINTS = [
  {
    code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE',
    pointer: '/data/attributes/cfBundleVersion',
    hint: (fields) =>
      `Build ${fields.previousBundleVersion ?? 'this number'} is already on App Store Connect. Upload a higher build number.`,
  },
];

// Pulls the useful lines out of altool's repeated log. Unknown codes keep
// Apple's own detail instead of a guessed translation.
export function explainAltool(output) {
  const field = (name) => output.match(new RegExp(`${name}\\s*:\\s*([^\\n]+)`))?.[1]?.trim();
  const code = field('iris-code') ?? output.match(/code\s*:\s*(ENTITY_ERROR\.\S+)/)?.[1];
  const pointer = field('pointer');
  const detail = field('detail');
  const previousBundleVersion = field('previousBundleVersion');
  const known = ALTOOL_HINTS.find((item) => item.code === code && item.pointer === pointer);
  const message = known?.hint({ previousBundleVersion }) ?? detail ?? 'altool failed to upload the IPA.';
  return {
    message,
    code,
    pointer,
    detail,
    previousBundleVersion,
  };
}

function rejectUpload(path, output) {
  const explained = explainAltool(output);
  const lines = [
    path,
    explained.code && `code: ${explained.code}`,
    explained.pointer && `field: ${explained.pointer}`,
    explained.detail,
  ].filter(Boolean);
  throw new StoreError(explained.message, lines);
}

function altoolArgs(ipa, { keyId, issuerId }, keyPath) {
  return [
    'altool',
    '--upload-app',
    '-f',
    ipa,
    '--api-key',
    keyId,
    '--api-issuer',
    issuerId,
    '--p8-file-path',
    keyPath,
  ];
}

export async function uploadIpa(ipa, { dryRun = true, account } = {}) {
  const reason = macOnlyReason();
  if (reason) throw new StoreError(reason);
  const bin = await xcrun();
  const identity = await readIpa(ipa);
  const creds = await credentials(identity.bundle_id, account);
  const plan = {
    ...identity,
    tool: 'xcrun altool --upload-app',
    account: creds.account,
    key_id: creds.keyId,
    mac_only: true,
  };
  if (dryRun) {
    return {
      ...plan,
      note: 'Dry run: nothing was uploaded. Show this plan to the user and run again with dry_run: false only after they explicitly confirm. Apple rejects a build number that is already uploaded.',
    };
  }
  let stdout = '';
  let stderr = '';
  try {
    const result = await withKeyFile(creds, (keyFile) =>
      exec(bin, altoolArgs(identity.path, creds, keyFile), { timeout: 20 * 60 * 1000, maxBuffer: 8_000_000 }),
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const detail = [err.stderr, err.stdout].filter(Boolean).join('\n').trim();
    rejectUpload(identity.path, detail || err.message);
  }
  const output = `${stdout}\n${stderr}`.trim();
  // altool can exit 0 while printing a rejection, such as a duplicate build.
  if (/Failed to upload|ERROR:/i.test(output)) rejectUpload(identity.path, output);
  return { ...plan, uploaded: true, output };
}
