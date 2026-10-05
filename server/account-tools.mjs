// Adds and removes named accounts, so nobody has to move key files or edit
// JSON by hand. Key contents are only parsed to check them, never returned.
import { createPrivateKey } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { accounts, accountsFile, asc, play } from './clients.mjs';
import { StoreError } from './util.mjs';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const expand = (p) => resolve(p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

// A key already in a hidden folder under home (~/.appstoreconnect, ~/.config…)
// stays put; one in Downloads or elsewhere moves to the standard folder.
const inPrivateFolder = (p) => {
  const rel = relative(homedir(), p);
  return !rel.startsWith('..') && rel.split(sep)[0].startsWith('.');
};

async function readAccountsFile() {
  const file = accountsFile();
  try {
    return { file, data: JSON.parse(await readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return { file, data: {} };
    throw new StoreError(`Can't read the accounts file ${file}: ${err.message}`);
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
    throw new StoreError(`${tilde(target)} already exists; pass replace: true to overwrite it`);
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

export const accountTools = [
  {
    name: 'account_add',
    description:
      "Adds (or replaces) a named App Store Connect or Google Play account from a downloaded key file, so the user never moves files or edits JSON. It moves the key into a private folder (readable only by the user), records it in the accounts file and tests it right away. App Store: the .p8 file plus the Issuer ID; the Key ID comes from the AuthKey_<KEYID>.p8 file name. Google Play: the service account .json. Never prints key contents. Use it whenever the user wants to connect a store account.",
    inputSchema: {
      type: 'object',
      required: ['store', 'name', 'key_file'],
      properties: {
        store: { type: 'string', enum: ['app_store', 'google_play'] },
        name: { type: 'string', description: 'Short account name, e.g. melody or acme (lowercase letters, digits, - and _)' },
        key_file: { type: 'string', description: 'Path to the downloaded .p8 (App Store) or service account .json (Play)' },
        issuer_id: { type: 'string', description: 'App Store only: the Issuer ID shown above the keys list' },
        key_id: { type: 'string', description: 'App Store only: needed when the file is not named AuthKey_<KEYID>.p8' },
        package: { type: 'string', description: 'Google Play only: a package to test access to' },
        keep_original: { type: 'boolean', default: false, description: 'Copy the key instead of moving it' },
        replace: { type: 'boolean', default: false, description: 'Overwrite an account or key that already exists' },
      },
    },
    async run({ store, name, key_file, issuer_id, key_id, package: pkg, keep_original = false, replace = false }) {
      if (!NAME.test(name ?? '')) throw new StoreError('name must be 1-32 lowercase letters, digits, - or _');
      const source = expand(key_file);
      if (!isAbsolute(source) || !(await stat(source).catch(() => null))?.isFile()) {
        throw new StoreError(`No key file at ${key_file}`);
      }
      const text = await readFile(source, 'utf8');
      const { file, data } = await readAccountsFile();
      const section = store === 'app_store' ? 'app_store' : 'google_play';
      if (data[section]?.[name] && !replace) {
        throw new StoreError(`There is already a ${section} account named "${name}"; pass replace: true to update it`);
      }

      let entry;
      let target;
      if (store === 'app_store') {
        const id = key_id ?? source.match(/AuthKey_([A-Z0-9]+)\.p8$/i)?.[1];
        if (!id) throw new StoreError('Pass key_id: the file is not named AuthKey_<KEYID>.p8');
        if (!UUID.test(issuer_id ?? '')) {
          throw new StoreError('Pass issuer_id: the UUID shown above the keys list in App Store Connect (Users and Access > Integrations)');
        }
        let key;
        try {
          key = createPrivateKey(text);
        } catch {
          throw new StoreError(`${key_file} is not a valid .p8 private key`);
        }
        if (key.asymmetricKeyType !== 'ec') throw new StoreError(`${key_file} is not an App Store Connect key (expected an EC key)`);
        // Apple's tools (altool, Transporter) look in this folder too.
        target = inPrivateFolder(source) ? source : join(homedir(), '.appstoreconnect', `AuthKey_${id.toUpperCase()}.p8`);
        entry = { key_id: id.toUpperCase(), issuer_id: issuer_id.toLowerCase(), private_key: tilde(target) };
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
        target = inPrivateFolder(source) ? source : join(dirname(accountsFile()), 'play', `${name}.json`);
        entry = { service_account: tilde(target) };
      }

      await placeKey(source, target, { keep: keep_original, replace });
      data[section] = { ...data[section], [name]: entry };
      await writeAccountsFile(file, data);

      const out = { account: name, store, key_file: tilde(target), accounts_file: tilde(file) };
      if (store === 'app_store') {
        out.key_id = entry.key_id;
        try {
          out.apps = (await asc(name).apps()).map((a) => `${a.name} (${a.bundleId})`);
          out.ok = true;
        } catch (err) {
          out.ok = false;
          out.error = [err.message, ...(err.details ?? [])].join(' ');
          out.hint = 'Check the Issuer ID and that the key belongs to this team, then run account_add again with replace: true.';
        }
      } else {
        try {
          const client = play(name);
          out.service_account = (await client.account()).client_email;
          await client.token();
          if (pkg) {
            await client.withEdit(pkg, async () => {});
            out.package_access = `${pkg}: ok`;
          }
          out.ok = true;
        } catch (err) {
          out.ok = false;
          out.error = err.message;
          out.hint = 'Invite the service account e-mail in Play Console (Users and permissions) with access to the app.';
        }
      }
      return out;
    },
  },

  {
    name: 'account_remove',
    description:
      'Removes a named account from the accounts file. The key file stays where it is; its path is returned so the user can delete it if they want.',
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
        const known = Object.keys(accounts()[store === 'app_store' ? 'asc' : 'play']);
        throw new StoreError(`No ${section} account named "${name}" in the accounts file (set up: ${known.join(', ') || 'none'})`);
      }
      delete data[section][name];
      await writeAccountsFile(file, data);
      return { removed: `${section}/${name}`, key_file_left: entry.private_key ?? entry.service_account, accounts_file: tilde(file) };
    },
  },
];
