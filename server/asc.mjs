import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ASC_EDITABLE } from './specs.mjs';
import { StoreError, assertHost, assertPlainPath, b64url, fetchRetry, md5, sleep } from './util.mjs';

const BASE = 'https://api.appstoreconnect.apple.com';

// Field names in tool input -> App Store Connect attribute names.
export const VERSION_FIELDS = {
  description: 'description',
  keywords: 'keywords',
  promotional_text: 'promotionalText',
  whats_new: 'whatsNew',
  marketing_url: 'marketingUrl',
  support_url: 'supportUrl',
};
export const INFO_FIELDS = {
  name: 'name',
  subtitle: 'subtitle',
  privacy_policy_url: 'privacyPolicyUrl',
  privacy_choices_url: 'privacyChoicesUrl',
};

export class AppStoreConnect {
  constructor({ keyId, issuerId, keyPath }) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.keyPath = keyPath;
  }

  async token() {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && this.jwtExp - now > 60) return this.jwt;
    if (!this.key) {
      const pem = await readFile(this.keyPath, 'utf8').catch(() => {
        throw new StoreError(`Can't read the App Store Connect key at ${this.keyPath}`);
      });
      try {
        this.key = createPrivateKey(pem);
      } catch {
        throw new StoreError(`${this.keyPath} is not a valid .p8 private key`);
      }
    }
    // Apple allows at most 20 minutes.
    const exp = now + 15 * 60;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.keyId, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iss: this.issuerId, iat: now, exp, aud: 'appstoreconnect-v1' }));
    const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
    this.jwt = `${header}.${payload}.${b64url(sig)}`;
    this.jwtExp = exp;
    return this.jwt;
  }

  url(path, query) {
    assertPlainPath(path);
    const u = new URL(path.startsWith('https://') ? path : BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    assertHost(u.href, ['api.appstoreconnect.apple.com']);
    return u.href;
  }

  // Any request; the body comes back as bytes so reports can be saved as-is.
  async raw(method, path, { query, body } = {}) {
    const url = this.url(path, query);
    const headers = { Authorization: `Bearer ${await this.token()}` };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetchRetry(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      let errors;
      try {
        errors = JSON.parse(buf.toString('utf8')).errors?.map((e) => [e.title, e.detail].filter(Boolean).join(': '));
      } catch {}
      const hint = res.status === 401 ? ' Check the key ID, issuer ID and .p8 file.' : '';
      throw new StoreError(
        `App Store Connect ${method} ${url.replace(BASE, '')} failed (${res.status}).${hint}`,
        errors ?? [buf.toString('utf8').slice(0, 300)],
      );
    }
    return { status: res.status, type: res.headers.get('content-type') ?? '', buf, url };
  }

  async req(method, path, body) {
    const { buf } = await this.raw(method, path, { body });
    return buf.length ? JSON.parse(buf.toString('utf8')) : null;
  }

  async all(path) {
    const data = [];
    let url = path;
    while (url) {
      const page = await this.req('GET', url);
      data.push(...page.data);
      url = page.links?.next;
    }
    return data;
  }

  async apps() {
    const data = await this.all('/v1/apps?limit=200&fields[apps]=name,bundleId,primaryLocale,sku');
    return data.map((a) => ({ id: a.id, ...a.attributes }));
  }

  // Accepts a bundle ID or a numeric Apple ID.
  async app(app) {
    if (/^\d+$/.test(app)) {
      const { data } = await this.req('GET', `/v1/apps/${app}`);
      return { id: data.id, ...data.attributes };
    }
    const { data } = await this.req('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(app)}`);
    const hit = data.find((a) => a.attributes.bundleId === app);
    if (!hit) throw new StoreError(`No app with bundle ID ${app} in this App Store Connect team`);
    return { id: hit.id, ...hit.attributes };
  }

  // Apple's order here is undocumented and `sort` is rejected, so read every
  // page and sort locally.
  async versions(appId, platform) {
    const data = await this.all(`/v1/apps/${appId}/appStoreVersions?filter[platform]=${platform}&limit=200`);
    return data
      .map((v) => ({
        id: v.id,
        version: v.attributes.versionString,
        state: v.attributes.appVersionState ?? v.attributes.appStoreState,
        created: v.attributes.createdDate,
      }))
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  }

  async editableVersion(appId, platform) {
    const versions = await this.versions(appId, platform);
    const v = versions.find((x) => ASC_EDITABLE.has(x.state));
    if (!v) {
      const list = versions.slice(0, 3).map((x) => `${x.version} (${x.state})`).join(', ') || 'none';
      throw new StoreError(
        `No editable ${platform} version. Screenshots and version text can only change on a version that is being prepared. Latest: ${list}. Create one with asc_version_create or in App Store Connect.`,
      );
    }
    return v;
  }

  createVersion(appId, platform, versionString) {
    return this.req('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform, versionString },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
  }

  async versionLocalizations(versionId) {
    const data = await this.all(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`);
    return data.map((l) => ({ id: l.id, ...l.attributes }));
  }

  async createVersionLocalization(versionId, locale, attributes = {}) {
    const { data } = await this.req('POST', '/v1/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale, ...attributes },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
    return { id: data.id, ...data.attributes };
  }

  updateVersionLocalization(id, attributes) {
    return this.req('PATCH', `/v1/appStoreVersionLocalizations/${id}`, {
      data: { type: 'appStoreVersionLocalizations', id, attributes },
    });
  }

  // The app info that can be edited, or the live one when none can.
  async appInfo(appId) {
    const { data } = await this.req('GET', `/v1/apps/${appId}/appInfos`);
    const state = (i) => i.attributes.state ?? i.attributes.appStoreState;
    const editable = data.find((i) => ASC_EDITABLE.has(state(i)));
    const info = editable ?? data[0];
    return info && { id: info.id, state: state(info), editable: !!editable };
  }

  async appInfoLocalizations(appInfoId) {
    const data = await this.all(`/v1/appInfos/${appInfoId}/appInfoLocalizations?limit=50`);
    return data.map((l) => ({ id: l.id, ...l.attributes }));
  }

  async createAppInfoLocalization(appInfoId, locale, attributes) {
    const { data } = await this.req('POST', '/v1/appInfoLocalizations', {
      data: {
        type: 'appInfoLocalizations',
        attributes: { locale, ...attributes },
        relationships: { appInfo: { data: { type: 'appInfos', id: appInfoId } } },
      },
    });
    return { id: data.id, ...data.attributes };
  }

  updateAppInfoLocalization(id, attributes) {
    return this.req('PATCH', `/v1/appInfoLocalizations/${id}`, {
      data: { type: 'appInfoLocalizations', id, attributes },
    });
  }

  async screenshotSets(localizationId) {
    const data = await this.all(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=50`);
    return data.map((s) => ({ id: s.id, displayType: s.attributes.screenshotDisplayType }));
  }

  async screenshots(setId) {
    const data = await this.all(`/v1/appScreenshotSets/${setId}/appScreenshots?limit=50`);
    return data.map((s) => ({
      id: s.id,
      fileName: s.attributes.fileName,
      state: s.attributes.assetDeliveryState?.state,
      imageAsset: s.attributes.imageAsset,
    }));
  }

  async createScreenshotSet(localizationId, displayType) {
    const { data } = await this.req('POST', '/v1/appScreenshotSets', {
      data: {
        type: 'appScreenshotSets',
        attributes: { screenshotDisplayType: displayType },
        relationships: {
          appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } },
        },
      },
    });
    return { id: data.id, displayType };
  }

  deleteScreenshot(id) {
    return this.req('DELETE', `/v1/appScreenshots/${id}`);
  }

  // Reserve, upload the parts Apple asks for, then commit with a checksum.
  async uploadScreenshot(setId, file) {
    const buf = await readFile(file.path);
    const { data } = await this.req('POST', '/v1/appScreenshots', {
      data: {
        type: 'appScreenshots',
        attributes: { fileName: file.name, fileSize: buf.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
      },
    });
    for (const op of data.attributes.uploadOperations ?? []) {
      assertHost(op.url, ['apple.com']);
      const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
      const res = await fetchRetry(op.url, {
        method: op.method,
        headers,
        body: buf.subarray(op.offset, op.offset + op.length),
      });
      if (!res.ok) throw new StoreError(`Uploading ${file.name} failed (${res.status})`);
    }
    await this.req('PATCH', `/v1/appScreenshots/${data.id}`, {
      data: { type: 'appScreenshots', id: data.id, attributes: { uploaded: true, sourceFileChecksum: md5(buf) } },
    });
    return data.id;
  }

  // Waits until Apple has processed the uploads; returns the ones that failed.
  async waitProcessed(ids, timeoutMs = 180000) {
    const pending = new Set(ids);
    const failed = [];
    const deadline = Date.now() + timeoutMs;
    while (pending.size && Date.now() < deadline) {
      for (const id of [...pending]) {
        const { data } = await this.req('GET', `/v1/appScreenshots/${id}?fields[appScreenshots]=fileName,assetDeliveryState`);
        const d = data.attributes.assetDeliveryState;
        if (d?.state === 'COMPLETE') pending.delete(id);
        if (d?.state === 'FAILED') {
          pending.delete(id);
          failed.push({ file: data.attributes.fileName, errors: (d.errors ?? []).map((e) => e.description ?? e.code) });
        }
      }
      if (pending.size) await sleep(2000);
    }
    return { failed, stillProcessing: pending.size };
  }

  reorder(setId, ids) {
    return this.req('PATCH', `/v1/appScreenshotSets/${setId}/relationships/appScreenshots`, {
      data: ids.map((id) => ({ type: 'appScreenshots', id })),
    });
  }
}

export const imageUrl = (asset) =>
  asset?.templateUrl?.replace('{w}', asset.width).replace('{h}', asset.height).replace('{f}', 'png');
