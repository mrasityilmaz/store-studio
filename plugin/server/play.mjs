import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FIRST_LINE_ONLY, StoreError, assertHost, assertPlainPath, b64url, fetchRetry, pemKey, setupHint } from './util.mjs';

export const HOST = 'https://androidpublisher.googleapis.com';
const API = `${HOST}/androidpublisher/v3/applications`;
const UPLOAD = `${HOST}/upload/androidpublisher/v3/applications`;
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

// Field names in tool input -> Play listing fields.
export const LISTING_FIELDS = {
  title: 'title',
  short_description: 'shortDescription',
  full_description: 'fullDescription',
  video: 'video',
};

export class GooglePlay {
  // The key comes from the plugin settings (serviceAccount, the .json
  // contents) or, for an account connected in the chat, from its file.
  constructor({ serviceAccount, serviceAccountPath }) {
    this.json = serviceAccount;
    this.path = serviceAccountPath;
  }

  async account() {
    if (this.sa) return this.sa;
    const fromFile = Boolean(this.path);
    const where = fromFile ? `The service account file ${this.path}` : 'The Google Play service account setting';
    const hint = fromFile ? 'Connect the account again with account_add, giving the downloaded .json key file.' : setupHint();
    const raw = fromFile
      ? await readFile(this.path, 'utf8').catch(() => {
          throw new StoreError(`Can't read the Google Play service account file ${this.path}. ${hint}`);
        })
      : this.json;
    const text = String(raw ?? '').trim();
    if (text === '{') throw new StoreError(`${where}: ${FIRST_LINE_ONLY}`);
    let sa;
    try {
      sa = JSON.parse(text);
    } catch {
      const why = /^[~/]/.test(text) ? 'holds a file path, not the key' : "isn't valid JSON";
      throw new StoreError(`${where} ${why}. ${hint}`);
    }
    if (sa?.type !== 'service_account' || !sa.private_key || !sa.client_email) {
      throw new StoreError(`${where} isn't a Google service account key (expected "type": "service_account"). ${hint}`);
    }
    this.sa = { ...sa, private_key: pemKey(sa.private_key, `The private key of ${sa.client_email}`, hint) };
    return this.sa;
  }

  async token() {
    const now = Math.floor(Date.now() / 1000);
    if (this.access && this.accessExp - now > 60) return this.access;
    const sa = await this.account();
    const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
    assertHost(tokenUri, ['googleapis.com']);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }));
    const claims = b64url(
      JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }),
    );
    const sig = b64url(sign('sha256', Buffer.from(`${header}.${claims}`), sa.private_key));
    const res = await fetchRetry(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${sig}`,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new StoreError(`Google sign-in for ${sa.client_email} failed (${res.status})`, [
        json.error_description ?? json.error ?? 'unknown error',
      ]);
    }
    this.access = json.access_token;
    this.accessExp = now + (json.expires_in ?? 3600);
    return this.access;
  }

  // Any request; the body comes back as bytes.
  async raw(method, url, { json, body, contentType } = {}) {
    assertHost(url, ['androidpublisher.googleapis.com']);
    assertPlainPath(url);
    const headers = { Authorization: `Bearer ${await this.token()}` };
    if (json) headers['Content-Type'] = 'application/json';
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetchRetry(url, { method, headers, body: json ? JSON.stringify(json) : body });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      let msg;
      try {
        msg = JSON.parse(buf.toString('utf8')).error?.message;
      } catch {}
      const hint =
        res.status === 403
          ? ' Invite the service account in Play Console (Users and permissions) with access to this app and its store listing, and enable the Google Play Android Developer API in its Cloud project. Sending changes for review or releasing also needs the release permission for that track.'
          : '';
      throw new StoreError(`Google Play ${method} failed (${res.status}): ${msg ?? buf.toString('utf8').slice(0, 300)}.${hint}`);
    }
    return { status: res.status, type: res.headers.get('content-type') ?? '', buf, url };
  }

  async req(method, url, opts) {
    const { buf } = await this.raw(method, url, opts);
    return buf.length ? JSON.parse(buf.toString('utf8')) : null;
  }

  base(pkg, editId) {
    return `${API}/${encodeURIComponent(pkg)}/edits/${editId}`;
  }

  async insertEdit(pkg) {
    const { id } = await this.req('POST', `${API}/${encodeURIComponent(pkg)}/edits`, { json: {} });
    return id;
  }

  deleteEdit(pkg, editId) {
    return this.req('DELETE', this.base(pkg, editId)).catch(() => {});
  }

  async commitEdit(pkg, editId, { sendForReview }) {
    const q = sendForReview ? '' : '?changesNotSentForReview=true';
    try {
      return await this.req('POST', `${this.base(pkg, editId)}:commit${q}`);
    } catch (err) {
      // Some apps can't hold changes back; committing there means review.
      if (!sendForReview && /\(400\)/.test(err.message)) {
        throw new StoreError(
          `${err.message} This app may not allow holding changes, so committing sends them for review. Ask the user, then retry with send_for_review: true.`,
        );
      }
      throw err;
    }
  }

  // Runs fn inside an edit. The edit is committed only when commit is set;
  // otherwise, or on error, it is thrown away.
  async withEdit(pkg, fn, { commit = false, sendForReview = false } = {}) {
    const editId = await this.insertEdit(pkg);
    let done = false;
    try {
      const result = await fn(editId);
      if (commit) {
        await this.commitEdit(pkg, editId, { sendForReview });
        done = true;
      }
      return result;
    } finally {
      if (!done) await this.deleteEdit(pkg, editId);
    }
  }

  async listings(pkg, editId) {
    const data = await this.req('GET', `${this.base(pkg, editId)}/listings`);
    return data?.listings ?? [];
  }

  async listing(pkg, editId, language) {
    return this.req('GET', `${this.base(pkg, editId)}/listings/${encodeURIComponent(language)}`).catch((err) => {
      if (/\(404\)/.test(err.message)) return null;
      throw err;
    });
  }

  putListing(pkg, editId, language, listing) {
    return this.req('PUT', `${this.base(pkg, editId)}/listings/${encodeURIComponent(language)}`, { json: { ...listing, language } });
  }

  async images(pkg, editId, language, type) {
    const data = await this.req('GET', `${this.base(pkg, editId)}/listings/${encodeURIComponent(language)}/${encodeURIComponent(type)}`);
    return data?.images ?? [];
  }

  deleteAllImages(pkg, editId, language, type) {
    return this.req('DELETE', `${this.base(pkg, editId)}/listings/${encodeURIComponent(language)}/${encodeURIComponent(type)}`);
  }

  uploadImage(pkg, editId, language, type, buf, contentType) {
    const url = `${UPLOAD}/${encodeURIComponent(pkg)}/edits/${editId}/listings/${encodeURIComponent(language)}/${encodeURIComponent(type)}?uploadType=media`;
    return this.req('POST', url, { body: buf, contentType });
  }

  // Returns { versionCode, sha1, sha256 } once Google has accepted the bundle.
  uploadBundle(pkg, editId, buf) {
    const url = `${UPLOAD}/${encodeURIComponent(pkg)}/edits/${editId}/bundles?uploadType=media`;
    return this.req('POST', url, { body: buf, contentType: 'application/octet-stream' });
  }

  async tracks(pkg, editId) {
    const data = await this.req('GET', `${this.base(pkg, editId)}/tracks`);
    return data?.tracks ?? [];
  }

  // Runs the checks a commit would, without committing.
  validateEdit(pkg, editId) {
    return this.req('POST', `${this.base(pkg, editId)}:validate`);
  }

  putTrack(pkg, editId, track, releases) {
    return this.req('PUT', `${this.base(pkg, editId)}/tracks/${encodeURIComponent(track)}`, { json: { track, releases } });
  }
}
