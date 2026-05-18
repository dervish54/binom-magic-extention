(() => {
  const SETTINGS_KEY = 'bmSettings';
  const SECRET_KEY = 'bmInstallSecret';
  const CACHE_KEY = 'bmCampaignResolutionCache';
  const DEFAULT_SOURCE_API_BASE = 'https://api.adskeeper.co.uk/v1';

  function localArea() { return chrome.storage.local; }
  function syncArea() { return chrome.storage.sync; }

  async function safeGet(area, keys) {
    try { return await area.get(keys); } catch (_) { return {}; }
  }
  async function safeSet(area, payload) {
    // TODO(ru/en): Не глотать ошибки storage молча; возвращать или логировать причину.
    // Иначе UI может показать "Saved", хотя запись фактически не произошла.
    // Do not swallow storage errors silently; return or log the reason.
    // Otherwise the UI can show "Saved" even when persistence actually failed.
    try { await area.set(payload); } catch (_) {}
  }
  async function safeRemove(area, keys) {
    try { await area.remove(keys); } catch (_) {}
  }

  function b64Encode(bytes) {
    let bin = '';
    for (const byte of bytes) bin += String.fromCharCode(byte);
    return btoa(bin);
  }

  function b64Decode(text) {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomB64(size = 32) {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    return b64Encode(bytes);
  }

  async function getOrCreateInstallSecret() {
    const local = await safeGet(localArea(), [SECRET_KEY]);
    if (local?.[SECRET_KEY]) {
      await safeSet(syncArea(), { [SECRET_KEY]: local[SECRET_KEY] });
      return local[SECRET_KEY];
    }

    const synced = await safeGet(syncArea(), [SECRET_KEY]);
    if (synced?.[SECRET_KEY]) {
      await safeSet(localArea(), { [SECRET_KEY]: synced[SECRET_KEY] });
      return synced[SECRET_KEY];
    }

    const secret = randomB64(32);
    await safeSet(localArea(), { [SECRET_KEY]: secret });
    await safeSet(syncArea(), { [SECRET_KEY]: secret });
    return secret;
  }

  async function getAesKey() {
    const secret = await getOrCreateInstallSecret();
    const material = new TextEncoder().encode(`bm:${chrome.runtime.id}:${secret}`);
    const digest = await crypto.subtle.digest('SHA-256', material);
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function encryptText(plainText) {
    const value = String(plainText || '');
    if (!value) return null;
    const key = await getAesKey();
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const payload = new TextEncoder().encode(value);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
    return `v1:${b64Encode(iv)}:${b64Encode(new Uint8Array(cipher))}`;
  }

  async function decryptText(cipherText) {
    if (!cipherText) return '';
    if (!String(cipherText).startsWith('v1:')) return String(cipherText);
    const [, ivText, bodyText] = String(cipherText).split(':');
    if (!ivText || !bodyText) return '';
    const key = await getAesKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64Decode(ivText) },
      key,
      b64Decode(bodyText)
    );
    return new TextDecoder().decode(plain);
  }

  function normalizeSource(source = {}) {
    return {
      name: String(source.name || '').trim(),
      trackerId: String(source.trackerId || source.tracker_id || '').trim(),
      idAuth: String(source.idAuth || '').trim(),
      apiToken: String(source.apiToken || '').trim(),
      apiBaseUrl: String(source.apiBaseUrl || '').trim()
    };
  }

  function normalizeCacheEntry(entry = {}) {
    const trackerCampaignId = String(entry.trackerCampaignId || '').trim();
    if (!trackerCampaignId) return null;
    return {
      trackerCampaignId,
      trafficSourceId: String(entry.trafficSourceId || '').trim(),
      sourceCampaignId: String(entry.sourceCampaignId || '').trim(),
      resolutionSource: String(entry.resolutionSource || '').trim(),
      apiAttempts: Number(entry.apiAttempts || 0),
      updatedAt: Number(entry.updatedAt || Date.now())
    };
  }

  async function getLegacySettings() {
    const legacy = await safeGet(localArea(), [
      'adskeeperToken',
      'adskeeperIdAuth',
      'adskeeperApiBase'
    ]);
    if (!legacy.adskeeperToken && !legacy.adskeeperIdAuth && !legacy.adskeeperApiBase) {
      return null;
    }
    return {
      tracker: {
        baseUrl: '',
        apiToken: ''
      },
      sources: [
        {
          name: '',
          trackerId: '',
          idAuth: legacy.adskeeperIdAuth || '',
          apiToken: legacy.adskeeperToken || '',
          apiBaseUrl: legacy.adskeeperApiBase || ''
        }
      ]
    };
  }

  async function readSettingsPayload() {
    const local = await safeGet(localArea(), [SETTINGS_KEY]);
    if (local?.[SETTINGS_KEY]) return local[SETTINGS_KEY];
    const synced = await safeGet(syncArea(), [SETTINGS_KEY]);
    if (synced?.[SETTINGS_KEY]) {
      await safeSet(localArea(), { [SETTINGS_KEY]: synced[SETTINGS_KEY] });
      return synced[SETTINGS_KEY];
    }
    return null;
  }

  async function readCachePayload() {
    const local = await safeGet(localArea(), [CACHE_KEY]);
    if (local?.[CACHE_KEY]) return local[CACHE_KEY];
    const synced = await safeGet(syncArea(), [CACHE_KEY]);
    if (synced?.[CACHE_KEY]) {
      await safeSet(localArea(), { [CACHE_KEY]: synced[CACHE_KEY] });
      return synced[CACHE_KEY];
    }
    return {};
  }

  async function getSettings() {
    const payload = await readSettingsPayload();
    if (!payload) return (await getLegacySettings()) || { tracker: { baseUrl: '', apiToken: '' }, sources: [] };

    const tracker = payload.tracker || {};
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const result = {
      tracker: {
        baseUrl: String(tracker.baseUrl || '').trim(),
        apiToken: await decryptText(tracker.apiTokenEnc || '')
      },
      sources: []
    };
    for (const source of sources) {
      result.sources.push({
        name: String(source.name || '').trim(),
        trackerId: String(source.trackerId || '').trim(),
        idAuth: String(source.idAuth || '').trim(),
        apiToken: await decryptText(source.apiTokenEnc || ''),
        apiBaseUrl: String(source.apiBaseUrl || '').trim()
      });
    }
    return result;
  }

  async function saveSettings(input = {}) {
    const tracker = input.tracker || {};
    const sources = Array.isArray(input.sources) ? input.sources.map(normalizeSource) : [];
    const cleanSources = sources.filter((source) => {
      return source.name || source.trackerId || source.idAuth || source.apiToken || source.apiBaseUrl;
    });

    const payload = {
      tracker: {
        baseUrl: String(tracker.baseUrl || '').trim(),
        apiTokenEnc: await encryptText(String(tracker.apiToken || '').trim())
      },
      sources: []
    };

    for (const source of cleanSources) {
      payload.sources.push({
        name: source.name,
        trackerId: source.trackerId,
        idAuth: source.idAuth,
        apiTokenEnc: await encryptText(source.apiToken),
        apiBaseUrl: source.apiBaseUrl || DEFAULT_SOURCE_API_BASE
      });
    }

    await safeSet(localArea(), { [SETTINGS_KEY]: payload });
    await safeSet(syncArea(), { [SETTINGS_KEY]: payload });
    await safeRemove(localArea(), ['adskeeperToken', 'adskeeperIdAuth', 'adskeeperApiBase']);
    return payload;
  }

  async function getSourceConfig(trafficSourceId) {
    const settings = await getSettings();
    const sources = Array.isArray(settings.sources) ? settings.sources : [];
    const wanted = trafficSourceId != null && String(trafficSourceId).trim()
      ? String(trafficSourceId).trim()
      : '';
    // TODO(ru/en): Не падать обратно на первую source-конфигурацию, если trackerId не разрешён точно.
    // Это может привести к использованию чужих кредов и работе не с тем аккаунтом.
    // Do not fall back to the first source config when trackerId is not resolved exactly.
    // That can cause the extension to use the wrong credentials and target the wrong account.
    const selected = (wanted && sources.find((source) => String(source.trackerId) === wanted)) || sources[0] || null;
    if (!selected) return null;
    return {
      ...selected,
      apiBaseUrl: selected.apiBaseUrl || DEFAULT_SOURCE_API_BASE
    };
  }

  async function getCampaignResolutionCache() {
    const payload = await readCachePayload();
    return payload && typeof payload === 'object' ? payload : {};
  }

  async function getCampaignResolution(trackerCampaignId) {
    const cache = await getCampaignResolutionCache();
    const key = String(trackerCampaignId || '').trim();
    return key ? (cache[key] || null) : null;
  }

  async function saveCampaignResolution(entry) {
    const normalized = normalizeCacheEntry(entry);
    if (!normalized) return null;
    const cache = await getCampaignResolutionCache();
    cache[normalized.trackerCampaignId] = normalized;
    // TODO(ru/en): Добавить TTL, очистку и лимиты размера, особенно для sync storage.
    // Сейчас кеш растёт без ограничений и может упереться в квоты Chrome.
    // Add TTL, cleanup, and size limits, especially for sync storage.
    // The cache currently grows without bounds and can hit Chrome quotas.
    await safeSet(localArea(), { [CACHE_KEY]: cache });
    await safeSet(syncArea(), { [CACHE_KEY]: cache });
    return normalized;
  }

  async function resetAllData() {
    await safeRemove(localArea(), [SETTINGS_KEY, SECRET_KEY, CACHE_KEY, 'adskeeperToken', 'adskeeperIdAuth', 'adskeeperApiBase']);
    await safeRemove(syncArea(), [SETTINGS_KEY, SECRET_KEY, CACHE_KEY]);
  }

  globalThis.BMSecureStorage = {
    SETTINGS_KEY,
    SECRET_KEY,
    CACHE_KEY,
    DEFAULT_SOURCE_API_BASE,
    getSettings,
    saveSettings,
    getSourceConfig,
    getCampaignResolutionCache,
    getCampaignResolution,
    saveCampaignResolution,
    resetAllData,
    decryptText,
    encryptText
  };
})();
