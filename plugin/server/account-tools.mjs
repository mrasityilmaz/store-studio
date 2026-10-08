// Connects accounts in the chat, so nobody has to paste key contents anywhere:
// the user gives the downloaded key file's path (and the Issuer ID for App
// Store Connect). A dry run shows the plan without opening the file; only a
// confirmed run reads it, moves it into a private folder and records its path.
// Key contents are only parsed to check them, never returned.
import { createPrivateKey } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONFIRM, accounts, accountsFile, asc, play } from './clients.mjs';
import { StoreError } from './util.mjs';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Z0-9]{6,20}$/;

const expand = (p) => resolve(/^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p);
// Home as written and as resolved (on a Mac /var is a link to /private/var).
const homes = () => {
  const home = homedir();
  try {
    return [...new Set([home, realpathSync(home)])];
  } catch {
    return [home];
  }
};
// The path relative to home, or null when it is outside.
const underHome = (p) => {
  for (const home of homes()) {
    const rel = relative(home, p);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return null;
};
// Paths under home are saved as ~/… with / on every system.
const tilde = (p) => {
  const rel = underHome(p);
  return rel ? `~/${rel.split(sep).join('/')}` : p;
};

// A key already in a hidden folder under home (~/.appstoreconnect, ~/.config…)
// stays put; one in Downloads or elsewhere moves to the standard folder.
const inPrivateFolder = (p) => Boolean(underHome(p)?.split(sep)[0].startsWith('.'));

async function readAccountsFile() {
  const file = accountsFile();
  try {
    return { file, data: JSON.parse(await readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return { file, data: {} };
    throw new StoreError(`Can't read the accounts file ${file}; fix or delete it, then connect the accounts again.`);
  }
}

async function writeAccountsFile(file, data) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

// Moves (or copies) the key into its private folder, readable by the user only.
async function placeKey(source, target, { keep, replace }) {
  if (source === target) {
    await chmod(target, 0o600);
    return;
  }
  if (!replace && (await stat(target).catch(() => null))) {
    throw new StoreError(`${tilde(target)} already exists; set replace to true to overwrite it`);
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (keep) await copyFile(source, target);
  else {
    try {
      await rename(source, target);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      await copyFile(source, target);
      await unlink(source);
    }
  }
  await chmod(target, 0o600);
}

// Where the new key ended up in the account list: under its own entry, or, if
// the same key is also in the plugin settings and works there, under that name.
const listedAs = (store, isIt) => Object.entries(accounts()[store]).find(([, a]) => isIt(a));

export const accountTools = [
  {
    name: 'account_add',
    description:
      "Connects an App Store Connect or Google Play account from the key file the user downloaded, so nobody pastes key contents anywhere. App Store: the AuthKey_<KEYID>.p8 path plus the Issuer ID (the Key ID comes from the file name). Google Play: the service account .json path. Dry run by default: shows what will happen without opening the file. Run with dry_run: false only after the user confirms; it then reads the file once to check it, moves it into a private folder readable only by the user (unless keep_original), records the path and IDs in the accounts file and signs in to test it. Works in every Claude Code app. Never prints key contents; never ask the user to paste them.",
    inputSchema: {
      type: 'object',
      required: ['store', 'name', 'key_file'],
      properties: {
        store: { type: 'string', enum: ['app_store', 'google_play'] },
        name: { type: 'string', description: 'Short account name, e.g. acme (lowercase letters, digits, - and _)' },
        key_file: { type: 'string', description: 'Path to the downloaded .p8 (App Store) or service account .json (Play)' },
        issuer_id: { type: 'string', description: 'App Store only: the Issuer ID shown above the keys list' },
        key_id: { type: 'string', description: 'App Store only: needed when the file is not named AuthKey_<KEYID>.p8' },
        package: { type: 'string', description: 'Google Play only: a package to test access to' },
        keep_original: { type: 'boolean', default: false, description: 'Copy the key instead of moving it' },
        replace: { type: 'boolean', default: false, description: 'Overwrite an account or key that already exists' },
        dry_run: { type: 'boolean', default: true },
      },
    },
    async run({ store, name, key_file, issuer_id, key_id, package: pkg, keep_original = false, replace = false, dry_run = true }) {
      if (!NAME.test(name ?? '')) throw new StoreError('name must be 1-32 lowercase letters, digits, - or _');
      if (typeof key_file !== 'string' || !key_file) throw new StoreError('Give key_file: the path of the downloaded key file');
      const given = expand(key_file);
      if (!(await stat(given).catch(() => null))?.isFile()) throw new StoreError(`No key file at ${key_file}`);
      // A link is followed, so the key itself is what moves.
      const source = await realpath(given);
      const { file, data } = await readAccountsFile();
      const section = store === 'app_store' ? 'app_store' : 'google_play';
      const kind = store === 'app_store' ? 'asc' : 'play';
      if (data[section]?.[name] && !replace) {
        throw new StoreError(`There is already a ${section} account named "${name}"; set replace to true to update it`);
      }
      const clash = accounts()[kind][name];
      if (clash && clash.source !== 'connected in chat') {
        throw new StoreError(`"${name}" is already the name of an account in the plugin settings; choose another name`);
      }

      // Everything that can be checked without opening the key file.
      let id;
      let target;
      if (store === 'app_store') {
        if (!/\.p8$/i.test(given)) throw new StoreError(`${key_file} is not a .p8 file; App Store Connect keys are AuthKey_<KEYID>.p8`);
        id = (key_id ?? given.match(/AuthKey_([A-Z0-9]+)\.p8$/i)?.[1])?.toUpperCase();
        if (!id) throw new StoreError('Give key_id: the file is not named AuthKey_<KEYID>.p8');
        if (!KEY_ID.test(id)) throw new StoreError('key_id must be the Key ID from App Store Connect: letters and digits only');
        if (!UUID.test(issuer_id ?? '')) {
          throw new StoreError('Give issuer_id: the UUID shown above the keys list in App Store Connect (Users and Access > Integrations)');
        }
        // Apple's tools (altool, Transporter) look in this folder too.
        target = inPrivateFolder(source) ? source : join(homedir(), '.appstoreconnect', `AuthKey_${id}.p8`);
      } else {
        if (!/\.json$/i.test(given)) throw new StoreError(`${key_file} is not a .json file; Google Play needs the service account's JSON key`);
        target = inPrivateFolder(source) ? source : join(dirname(accountsFile()), 'play', `${name}.json`);
      }
      const willMove = target !== source;
      // Checked before the dry run too, so the plan never promises a move the
      // confirmed run would refuse.
      const occupied = willMove && Boolean(await stat(target).catch(() => null));
      if (occupied && !replace) {
        throw new StoreError(`${tilde(target)} already exists; set replace to true to overwrite it`);
      }

      if (dry_run) {
        return {
          plan: {
            account: name,
            store,
            key_file: tilde(source),
            ...(id && { key_id: id, issuer_id: issuer_id.toLowerCase() }),
            ...(willMove && { [keep_original ? 'copy_to' : 'move_to']: tilde(target) }),
            ...(occupied && { overwrites: tilde(target) }),
            accounts_file: tilde(file),
            then: 'reads the key once to check it, records its path and IDs (never its contents), and signs in to test it',
          },
          note: `${CONFIRM} The key file has not been opened.`,
        };
      }

      const text = await readFile(source, 'utf8');
      let entry;
      let email;
      if (store === 'app_store') {
        let key;
        try {
          key = createPrivateKey(text);
        } catch {
          throw new StoreError(`${key_file} is not a valid .p8 private key`);
        }
        if (key.asymmetricKeyType !== 'ec') throw new StoreError(`${key_file} is not an App Store Connect key (expected an EC key)`);
        entry = { key_id: id, issuer_id: issuer_id.toLowerCase(), private_key: tilde(target) };
      } else {
        let sa;
        try {
          sa = JSON.parse(text);
        } catch {
          throw new StoreError(`${key_file} is not valid JSON`);
        }
        if (sa.type !== 'service_account' || !sa.private_key || !sa.client_email) {
          throw new StoreError(`${key_file} is not a Google service account key`);
        }
        email = sa.client_email;
        entry = { service_account: tilde(target) };
      }

      await placeKey(source, target, { keep: keep_original, replace });
      data[section] = { ...data[section], [name]: entry };
      await writeAccountsFile(file, data);

      const out = { account: name, store, key_file: tilde(target), accounts_file: tilde(file) };
      if (store === 'app_store') {
        out.key_id = entry.key_id;
        const [as, listed] = listedAs('asc', (a) => (a.keyPath ? a.keyPath === target : a.keyId === id)) ?? [];
        if (as && as !== name) out.note = `This key is also in the plugin settings, so it is listed once, as "${as}".`;
        try {
          out.apps = (await asc(as ?? name).apps()).map((a) => `${a.name} (${a.bundleId})`);
          out.ok = true;
        } catch (err) {
          out.ok = false;
          out.error = [err.message, ...(err.details ?? [])].join(' ');
          out.hint = `Check the Issuer ID and that the key belongs to this team, then run account_add again with key_file ${tilde(listed?.keyPath ?? target)} and replace set to true.`;
        }
      } else {
        out.service_account = email;
        const sameAccount = (a) => {
          if (a.serviceAccountPath) return a.serviceAccountPath === target;
          try {
            return JSON.parse(a.serviceAccount).client_email === email;
          } catch {
            return false;
          }
        };
        const [as] = listedAs('play', sameAccount) ?? [];
        if (as && as !== name) out.note = `This service account is also in the plugin settings, so it is listed once, as "${as}".`;
        try {
          const client = play(as ?? name);
          await client.token();
          if (pkg) {
            await client.withEdit(pkg, async () => {});
            out.package_access = `${pkg}: ok`;
          }
          out.ok = true;
        } catch (err) {
          out.ok = false;
          out.error = err.message;
          out.hint = `Invite the service account e-mail in Play Console (Users and permissions) with access to the app. To use another key file, run account_add again with replace set to true.`;
        }
      }
      return out;
    },
  },

  {
    name: 'account_remove',
    description:
      'Disconnects an account that was connected in the chat: removes it from the accounts file. The key file stays where it is; its path is returned so the user can delete it if they want. Accounts in the plugin settings are changed in the settings instead.',
    inputSchema: {
      type: 'object',
      required: ['store', 'name'],
      properties: { store: { type: 'string', enum: ['app_store', 'google_play'] }, name: { type: 'string' } },
    },
    async run({ store, name }) {
      const { file, data } = await readAccountsFile();
      const section = store === 'app_store' ? 'app_store' : 'google_play';
      const entry = data[section]?.[name];
      if (!entry) {
        const known = Object.keys(data[section] ?? {});
        throw new StoreError(`No ${section} account named "${name}" was connected in the chat (connected: ${known.join(', ') || 'none'})`);
      }
      delete data[section][name];
      await writeAccountsFile(file, data);
      return { removed: `${section}/${name}`, key_file_left: entry.private_key ?? entry.service_account, accounts_file: tilde(file) };
    },
  },
];
