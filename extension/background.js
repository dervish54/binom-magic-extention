// MV3 service worker: prefetch Adskeeper metrics for the hover overlay and copy IDs JSON

try { importScripts('secure-storage.js'); } catch (_) {}

const MENU_ID = 'binom_magic_copy_ids';
const MENU_INJECT_AK = 'binom_magic_inject_ak';

function log(...args) {
  try { console.log('[BinomMagicBG]', ...args); } catch (_) {}
}
let __lastDebugTabId = null;
function debugToTab(tabId, event, payload) {
  try {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'AK_DEBUG_LOG', event, payload });
  } catch (_) {}
}
function emitMetricToTab(entity, id, data, extra = {}) {
  try {
    if (!__lastDebugTabId) return;
    chrome.tabs.sendMessage(__lastDebugTabId, Object.assign({ type: 'AK_METRIC', entity, id, data }, extra));
  } catch (_) {}
}
function redactAuth(headers) {
  const h = { ...(headers || {}) };
  if (h.Authorization) {
    const v = String(h.Authorization);
    h.Authorization = v.length > 16 ? v.slice(0, 10) + 'вЂ¦' + v.slice(-4) : '***';
  }
  return h;
}

function toDateOnly(s) {
  try { return String(s || '').slice(0, 10); } catch (_) { return ''; }
}

function trunc(s, len = 1800) {
  try {
    const t = String(s ?? '');
    return t.length > len ? t.slice(0, len) + 'вЂ¦' : t;
  } catch (_) { return ''; }
}

async function loadRuntimeSettings() {
  if (globalThis.BMSecureStorage?.getSettings) {
    return globalThis.BMSecureStorage.getSettings();
  }
  const legacy = await chrome.storage.local.get([
    'adskeeperToken',
    'adskeeperIdAuth',
    'adskeeperApiBase'
  ]);
  return {
    tracker: { baseUrl: '', apiToken: '' },
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

async function loadSourceCredentials(msg = {}) {
  const resolvedTrafficSourceId = await resolveTrafficSourceId(msg);
  if (globalThis.BMSecureStorage?.getSourceConfig) {
    // TODO(ru/en): Требовать точное совпадение source по trackerId и явно падать,
    // если резолв неоднозначен или пуст.
    // Require an exact source match by trackerId and fail explicitly
    // when the resolution is ambiguous or empty.
    const sourceConfig = await globalThis.BMSecureStorage.getSourceConfig(resolvedTrafficSourceId || msg.sourceTrackerId || '');
    if (!sourceConfig) return null;
    return {
      token: sourceConfig.apiToken || '',
      idAuth: sourceConfig.idAuth || '',
      apiBase: sourceConfig.apiBaseUrl || globalThis.BMSecureStorage.DEFAULT_SOURCE_API_BASE,
      trackerId: sourceConfig.trackerId || resolvedTrafficSourceId || '',
      sourceName: sourceConfig.name || ''
    };
  }

  const settings = await loadRuntimeSettings();
  const first = Array.isArray(settings.sources) ? settings.sources[0] : null;
  if (!first) return null;
  return {
    token: first.apiToken || '',
    idAuth: first.idAuth || '',
    apiBase: first.apiBaseUrl || 'https://api.adskeeper.co.uk/v1',
    trackerId: first.trackerId || '',
    sourceName: first.name || ''
  };
}

async function loadTrackerCredentials() {
  const settings = await loadRuntimeSettings();
  const tracker = settings?.tracker || {};
  return {
    // TODO(ru/en): Валидировать схему и host tracker base URL до любого fetch.
    // Сейчас возможны произвольные http/https адреса, что повышает риск утечки Api-Key при ошибке настройки.
    // Validate the tracker base URL scheme and host before any fetch.
    // Arbitrary http/https endpoints are currently possible, which increases Api-Key leakage risk on bad config.
    baseUrl: String(tracker.baseUrl || '').replace(/\/+$/, ''),
    apiToken: String(tracker.apiToken || '').trim()
  };
}

async function fetchTrackerCampaignDetails(trackerCampaignId) {
  const tracker = await loadTrackerCredentials();
  if (!tracker.baseUrl || !tracker.apiToken || !trackerCampaignId) return null;
  const url = `${tracker.baseUrl}/public/api/v1/campaign/${encodeURIComponent(String(trackerCampaignId))}`;
  const resp = await fetch(url, {
    headers: {
      'Api-Key': tracker.apiToken,
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) throw new Error(`Tracker campaign lookup ${resp.status}`);
  return resp.json();
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function serializeTrackerCampaignIds(values) {
  return uniqueStrings(values).sort().join(',');
}

function normalizeTrackerDateTime(value, edge = 'start') {
  const raw = String(value || '').trim().replace('T', ' ');
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw} ${edge === 'end' ? '23:59:59' : '00:00:00'}`;
  }
  return raw;
}

async function fetchTrackerCampaignReport({ trackerCampaignIds, groupings, startDate, endDate, timeZone = '', dateType = '', nameFilter = '' }) {
  const tracker = await loadTrackerCredentials();
  const ids = uniqueStrings(trackerCampaignIds);
  const groupingValues = uniqueStrings(groupings);
  if (!tracker.baseUrl || !tracker.apiToken) throw new Error('Missing tracker credentials in Options');
  if (!ids.length) throw new Error('Missing tracker campaign ids for tracker report lookup');
  if (!groupingValues.length) throw new Error('Missing groupings for tracker report lookup');

  const query = new URLSearchParams();
  ids.forEach((id) => query.append('ids[]', id));
  groupingValues.forEach((grouping) => query.append('groupings[]', grouping));
  const sDate = normalizeTrackerDateTime(startDate, 'start');
  const eDate = normalizeTrackerDateTime(endDate, 'end');
  if (sDate && eDate) {
    query.set('datePreset', 'custom_time');
    query.set('dateFrom', sDate);
    query.set('dateTo', eDate);
  } else if (dateType) {
    query.set('datePreset', String(dateType).replace(/-/g, '_'));
  }
  if (timeZone) query.set('timezone', timeZone);
  if (nameFilter) query.set('nameFilter', String(nameFilter));
  // TODO(ru/en): Добавить пагинацию или обход страниц.
  // Жёсткий limit=500 может терять часть кампаний и ломать резолвинг на больших отчётах.
  // Add pagination or page iteration.
  // A hard limit=500 can miss campaigns and break resolution on large reports.
  query.set('limit', '500');
  query.set('sortColumn', 'clicks');
  query.set('sortType', 'desc');

  const url = `${tracker.baseUrl}/public/api/v1/report/campaign?${query.toString()}`;
  const headers = {
    'Api-Key': tracker.apiToken,
    'Accept': 'application/json'
  };
  log('GET tracker report/campaign', { ids, groupings: groupingValues, nameFilter, url });
  return httpJsonWithRetries('tracker-report-campaign', url, headers, nameFilter || ids.join(','));
}

function extractTrackerReportRows(payload) {
  if (Array.isArray(payload?.report)) return payload.report;
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const value of Object.values(payload)) {
      if (Array.isArray(value) && value.every((row) => row && typeof row === 'object')) return value;
    }
  }
  return [];
}

function reportRowLevel(row) {
  const level = Number(row?.level);
  return Number.isFinite(level) ? level : null;
}

function extractReportEntityId(row, minDigits = 1) {
  const candidates = [row?.entity_id, row?.entityId, row?.id, row?.name];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (minDigits <= 1 && text) return text;
    if (new RegExp(`^\\d{${minDigits},}$`).test(text)) return text;
  }
  return null;
}

function rowMatchesEntity(row, entityId) {
  const wanted = String(entityId || '').trim();
  if (!wanted) return false;
  return [row?.entity_id, row?.entityId, row?.id, row?.name].some((candidate) => String(candidate || '').trim() === wanted);
}

function extractChildCampaignIdsForParent(rows, parentEntityId) {
  const result = [];
  let inMatch = false;
  for (const row of rows) {
    const level = reportRowLevel(row);
    if (level === 1) {
      inMatch = rowMatchesEntity(row, parentEntityId);
      continue;
    }
    if (!inMatch) continue;
    if (level !== 2) continue;
    const trackerCampaignId = extractReportEntityId(row, 1);
    if (trackerCampaignId) result.push(trackerCampaignId);
  }
  return uniqueStrings(result);
}

function extractToken3ForCampaign(rows, trackerCampaignId) {
  let inMatch = false;
  for (const row of rows) {
    const level = reportRowLevel(row);
    if (level === 1) {
      const currentCampaignId = extractReportEntityId(row, 1);
      inMatch = currentCampaignId === String(trackerCampaignId || '').trim();
      continue;
    }
    if (!inMatch) continue;
    if (level !== 2) continue;
    const sourceCampaignId = extractReportEntityId(row, 1);
    if (sourceCampaignId) return sourceCampaignId;
  }
  return '';
}

async function resolveTrackerCampaignMapping(trackerCampaignId, scope = {}) {
  const trackerId = String(trackerCampaignId || '').trim();
  if (!trackerId) return null;

  const cached = await globalThis.BMSecureStorage?.getCampaignResolution?.(trackerId);
  let trafficSourceId = String(cached?.trafficSourceId || '').trim();
  let sourceCampaignId = String(cached?.sourceCampaignId || '').trim();

  if (!trafficSourceId) {
    const campaign = await fetchTrackerCampaignDetails(trackerId).catch(() => null);
    trafficSourceId = campaign?.trafficSourceId ? String(campaign.trafficSourceId) : '';
  }

  if (!sourceCampaignId) {
    const payload = await fetchTrackerCampaignReport({
      trackerCampaignIds: [trackerId],
      groupings: ['campaign', 'token_3'],
      startDate: scope.startDate,
      endDate: scope.endDate,
      timeZone: scope.timeZone || '',
      dateType: scope.dateType || ''
    }).catch(() => null);
    const rows = extractTrackerReportRows(payload);
    sourceCampaignId = extractToken3ForCampaign(rows, trackerId);
  }

  if (trafficSourceId || sourceCampaignId) {
    await globalThis.BMSecureStorage?.saveCampaignResolution?.({
      trackerCampaignId: trackerId,
      trafficSourceId,
      sourceCampaignId,
      resolutionSource: sourceCampaignId ? 'tracker_report_token3' : 'tracker_campaign_api',
      apiAttempts: Number(cached?.apiAttempts || 0) + 1,
      updatedAt: Date.now()
    });
  }

  return {
    trackerCampaignId: trackerId,
    trafficSourceId,
    sourceCampaignId
  };
}

async function resolveScopedTeaserCampaignMapping(teaserId, trackerCampaignIds, scope = {}) {
  const payload = await fetchTrackerCampaignReport({
    trackerCampaignIds,
    groupings: ['token_2', 'campaign'],
    startDate: scope.startDate,
    endDate: scope.endDate,
    timeZone: scope.timeZone || '',
    dateType: scope.dateType || '',
    nameFilter: teaserId
  });
  const rows = extractTrackerReportRows(payload);
  const matches = extractChildCampaignIdsForParent(rows, teaserId);
  if (!matches.length) return null;
  const mapping = await resolveTrackerCampaignMapping(matches[0], scope);
  return mapping ? { ...mapping, matchedTrackerCampaignIds: matches } : null;
}

async function resolveScopedWidgetCampaignMappings(widgetId, trackerCampaignIds, scope = {}) {
  const payload = await fetchTrackerCampaignReport({
    trackerCampaignIds,
    groupings: ['token_1', 'campaign'],
    startDate: scope.startDate,
    endDate: scope.endDate,
    timeZone: scope.timeZone || '',
    dateType: scope.dateType || '',
    nameFilter: widgetId
  });
  const rows = extractTrackerReportRows(payload);
  const matches = extractChildCampaignIdsForParent(rows, widgetId);
  const resolved = [];
  for (const trackerCampaignId of matches) {
    const mapping = await resolveTrackerCampaignMapping(trackerCampaignId, scope);
    if (mapping?.sourceCampaignId) resolved.push(mapping);
  }
  return resolved;
}

async function resolveScopedSourceCampaignMapping(sourceCampaignId, trackerCampaignIds, scope = {}) {
  const sourceId = String(sourceCampaignId || '').trim();
  const scopedTrackerCampaignIds = uniqueStrings(trackerCampaignIds);
  if (!sourceId || !scopedTrackerCampaignIds.length) return null;
  const payload = await fetchTrackerCampaignReport({
    trackerCampaignIds: scopedTrackerCampaignIds,
    groupings: ['token_3', 'campaign'],
    startDate: scope.startDate,
    endDate: scope.endDate,
    timeZone: scope.timeZone || '',
    dateType: scope.dateType || '',
    nameFilter: sourceId
  });
  const rows = extractTrackerReportRows(payload);
  const matches = extractChildCampaignIdsForParent(rows, sourceId);
  if (!matches.length) return null;
  const resolved = [];
  for (const trackerCampaignId of matches) {
    const mapping = await resolveTrackerCampaignMapping(trackerCampaignId, scope);
    if (mapping?.trafficSourceId || mapping?.sourceCampaignId) resolved.push(mapping);
  }
  const first = resolved[0] || null;
  if (!first) return null;
  return {
    trackerCampaignId: first.trackerCampaignId,
    trafficSourceId: first.trafficSourceId,
    sourceCampaignId: sourceId,
    matchedTrackerCampaignIds: matches
  };
}

async function resolveTrafficSourceId(msg = {}) {
  const direct = String(msg.trafficSourceId || msg.sourceTrackerId || '').trim();
  if (direct) return direct;

  const trackerCampaignId = String(msg.trackerCampaignId || '').trim();
  if (!trackerCampaignId) return '';

  const cached = await globalThis.BMSecureStorage?.getCampaignResolution?.(trackerCampaignId);
  if (cached?.trafficSourceId) return String(cached.trafficSourceId);

  const campaign = await fetchTrackerCampaignDetails(trackerCampaignId).catch(() => null);
  const trafficSourceId = campaign?.trafficSourceId ? String(campaign.trafficSourceId) : '';
  if (trafficSourceId && globalThis.BMSecureStorage?.saveCampaignResolution) {
    await globalThis.BMSecureStorage.saveCampaignResolution({
      trackerCampaignId,
      trafficSourceId,
      sourceCampaignId: String(msg.sourceCampaignId || msg.campaignId || '').trim(),
      resolutionSource: 'tracker_campaign_api',
      apiAttempts: 0,
      updatedAt: Date.now()
    });
  }
  return trafficSourceId;
}

async function resolveActionContext(msg = {}) {
  const entity = msg.entity === 'widget' ? 'widget' : (msg.entity === 'campaign' ? 'campaign' : 'teaser');
  const entityId = String(msg.id || '').trim();
  const trackerCampaignIds = uniqueStrings(msg.trackerCampaignIds || []);
  const entityGrouping = String(msg.entityGrouping || '').trim();
  const campaignScopeKind = String(msg.campaignScopeKind || '').trim();
  const scope = {
    startDate: msg.startDate || '',
    endDate: msg.endDate || '',
    timeZone: msg.timeZone || '',
    dateType: msg.dateType || ''
  };

  let effectiveTrackerCampaignId = String(msg.trackerCampaignId || '').trim();
  let effectiveSourceCampaignId = String(msg.sourceCampaignId || msg.campaignId || '').trim();
  let resolvedTrafficSourceId = String(msg.trafficSourceId || '').trim();

  if (entity === 'campaign') {
    if (campaignScopeKind === 'tracker' || entityGrouping === 'campaign') {
      effectiveSourceCampaignId = '';
    } else if (campaignScopeKind === 'source' || entityGrouping === 'token_3') {
      effectiveTrackerCampaignId = '';
    }
    if (!effectiveSourceCampaignId && effectiveTrackerCampaignId) {
      const mapping = await resolveTrackerCampaignMapping(effectiveTrackerCampaignId, scope);
      effectiveSourceCampaignId = String(mapping?.sourceCampaignId || '').trim();
      resolvedTrafficSourceId = String(mapping?.trafficSourceId || resolvedTrafficSourceId || '').trim();
    } else if (effectiveSourceCampaignId && !effectiveTrackerCampaignId && trackerCampaignIds.length) {
      const mapping = await resolveScopedSourceCampaignMapping(effectiveSourceCampaignId, trackerCampaignIds, scope);
      effectiveTrackerCampaignId = String(mapping?.trackerCampaignId || '').trim();
      resolvedTrafficSourceId = String(mapping?.trafficSourceId || resolvedTrafficSourceId || '').trim();
    }
  } else if (entity === 'teaser') {
    if (!effectiveTrackerCampaignId && trackerCampaignIds.length) {
      const teaserMapping = await resolveScopedTeaserCampaignMapping(entityId, trackerCampaignIds, scope);
      effectiveTrackerCampaignId = String(teaserMapping?.trackerCampaignId || '').trim();
      effectiveSourceCampaignId = String(teaserMapping?.sourceCampaignId || effectiveSourceCampaignId || '').trim();
      resolvedTrafficSourceId = String(teaserMapping?.trafficSourceId || resolvedTrafficSourceId || '').trim();
    } else if (!effectiveSourceCampaignId && effectiveTrackerCampaignId) {
      const mapping = await resolveTrackerCampaignMapping(effectiveTrackerCampaignId, scope);
      effectiveSourceCampaignId = String(mapping?.sourceCampaignId || '').trim();
      resolvedTrafficSourceId = String(mapping?.trafficSourceId || resolvedTrafficSourceId || '').trim();
    }
  } else if (entity === 'widget') {
    if (!effectiveTrackerCampaignId && trackerCampaignIds.length) {
      const widgetMappings = await resolveScopedWidgetCampaignMappings(entityId, trackerCampaignIds, scope);
      const widgetMapping = widgetMappings[0] || null;
      effectiveTrackerCampaignId = String(widgetMapping?.trackerCampaignId || '').trim();
      effectiveSourceCampaignId = String(widgetMapping?.sourceCampaignId || effectiveSourceCampaignId || '').trim();
      resolvedTrafficSourceId = String(widgetMapping?.trafficSourceId || resolvedTrafficSourceId || '').trim();
    } else if (!effectiveSourceCampaignId && effectiveTrackerCampaignId) {
      const mapping = await resolveTrackerCampaignMapping(effectiveTrackerCampaignId, scope);
      effectiveSourceCampaignId = String(mapping?.sourceCampaignId || '').trim();
      resolvedTrafficSourceId = String(mapping?.trafficSourceId || resolvedTrafficSourceId || '').trim();
    }
  }

  if (!resolvedTrafficSourceId && effectiveTrackerCampaignId) {
    const mapping = await resolveTrackerCampaignMapping(effectiveTrackerCampaignId, scope);
    resolvedTrafficSourceId = String(mapping?.trafficSourceId || '').trim();
    if (!effectiveSourceCampaignId) {
      effectiveSourceCampaignId = String(mapping?.sourceCampaignId || '').trim();
    }
  }

  return {
    entity,
    entityId,
    trackerCampaignIds,
    scope,
    entityGrouping,
    campaignScopeKind,
    trackerCampaignId: effectiveTrackerCampaignId,
    sourceCampaignId: effectiveSourceCampaignId,
    trafficSourceId: resolvedTrafficSourceId
  };
}

function buildTrackerCostPayload(msg = {}, cost, entityId = '') {
  const payload = {
    datePreset: 'custom_time',
    dateFrom: normalizeTrackerDateTime(msg.startDate || '', 'start'),
    dateTo: normalizeTrackerDateTime(msg.endDate || '', 'end'),
    timezone: String(msg.timeZone || 'Europe/Moscow'),
    cost: Number(cost),
    currency: 'USD',
    model: 'COSTS'
  };
  if (msg.entity === 'teaser') {
    payload.tokenId = 2;
    payload.tokenValue = String(entityId || '');
  } else if (msg.entity === 'widget') {
    payload.tokenId = 1;
    payload.tokenValue = String(entityId || '');
  }
  return payload;
}

// --- Robust HTTP with retries and backoff ---
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 700; // base backoff (tuned to avoid rate limits)
const JITTER = 0.25; // +-25%

function rndJitter() { return 1 + (Math.random() * 2 - 1) * JITTER; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseRetryAfter(headers) {
  try {
    const ra = headers.get ? headers.get('Retry-After') : (headers?.['Retry-After'] || headers?.['retry-after']);
    if (!ra) return null;
    const asNum = Number(ra);
    if (Number.isFinite(asNum)) return Math.max(0, asNum * 1000);
    const ts = Date.parse(ra);
    if (Number.isFinite(ts)) {
      const ms = ts - Date.now();
      return ms > 0 ? ms : null;
    }
    return null;
  } catch (_) { return null; }
}

async function httpJsonWithRetries(kind, url, headers, idLabel) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt === 1) debugToTab(__lastDebugTabId, 'REQUEST', { kind, id: idLabel, url, headers: redactAuth(headers) });
      else debugToTab(__lastDebugTabId, 'REQUEST', { kind, id: idLabel, url, headers: redactAuth(headers), attempt });
      const resp = await fetch(url, { headers });
      const status = resp.status;
      const text = await resp.text();
      debugToTab(__lastDebugTabId, 'RESPONSE', { kind, id: idLabel, status, body: trunc(text) });
      if (!resp.ok) {
        if (RETRY_STATUS.has(status) && attempt < MAX_ATTEMPTS) {
          const ra = parseRetryAfter(resp.headers);
          const backoff = Math.round((ra != null ? ra : BASE_DELAY_MS * Math.pow(2, attempt - 1)) * rndJitter());
          debugToTab(__lastDebugTabId, 'RETRY', { kind, id: idLabel, status, attempt, delayMs: backoff });
          await delay(backoff);
          continue;
        }
        throw new Error(`${kind} ${status}`);
      }
      try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw e;
      const backoff = Math.round((BASE_DELAY_MS * Math.pow(2, attempt - 1)) * rndJitter());
      debugToTab(__lastDebugTabId, 'RETRY', { kind, id: idLabel, attempt, delayMs: backoff, error: String(e && e.message || e) });
      await delay(backoff);
    }
  }
}

function refreshContextMenus() {
  // Remove all items from this extension, then create our menu item.
  chrome.contextMenus.removeAll(() => {
    // Ignore errors from removeAll (none expected for our own items)
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Binom Magic: Copy IDs JSON',
      contexts: ['all']
    }, () => {
      // Suppress duplicate id errors silently
      void chrome.runtime.lastError;
    });
    chrome.contextMenus.create({
      id: MENU_INJECT_AK,
      title: 'Binom Magic: Prefetch Hover Metrics',
      contexts: ['all']
    }, () => void chrome.runtime.lastError);
    log('Context menus refreshed');
  });
}

// Create menu on install/update and on browser startup
chrome.runtime.onInstalled.addListener(() => refreshContextMenus());
chrome.runtime.onStartup?.addListener?.(() => refreshContextMenus());
// Also refresh whenever the service worker starts
refreshContextMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  log('Context menu clicked', { id: info.menuItemId, pageUrl: info.pageUrl, tabId: tab?.id, tabUrl: tab?.url });
  if (!tab?.id) return;
  const type = info.menuItemId === MENU_ID ? 'BINOM_MAGIC_COPY_IDS'
                : info.menuItemId === MENU_INJECT_AK ? 'BINOM_MAGIC_INJECT_LIVE'
                : null;
  if (!type) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/binom-demo.js'] });
      await chrome.tabs.sendMessage(tab.id, { type });
    } catch (err) {
      console.error('[BinomMagicDemo] contextMenus click failed:', err);
    }
  }
});

// Allow content script to proactively request (re)creation of menus
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'BINOM_MAGIC_ENSURE_MENUS') {
    refreshContextMenus();
    sendResponse?.({ ok: true });
    return; 
  }

  if (msg && msg.type === 'AK_ACTION_UPDATE_COST') {
    __lastDebugTabId = sender?.tab?.id || null;
    (async () => {
      try {
        log('ACTION update-cost start', {
          actionTraceId: msg.actionTraceId || null,
          entity: msg.entity || null,
          id: msg.id || null,
          trackerCampaignId: msg.trackerCampaignId || null,
          sourceCampaignId: msg.sourceCampaignId || msg.campaignId || null,
          spend: msg.spend
        });
        const ctx = await resolveActionContext(msg);
        log('ACTION update-cost resolved', {
          actionTraceId: msg.actionTraceId || null,
          ctx
        });
        const tracker = await loadTrackerCredentials();
        const trackerCampaignId = String(ctx.trackerCampaignId || '').trim();
        const cost = Number(msg.spend);
        if (!tracker.baseUrl || !tracker.apiToken) {
          sendResponse?.({ ok: false, statusCode: 'local', error: 'Missing tracker credentials in Options' });
          return;
        }
        if (!trackerCampaignId) {
          sendResponse?.({ ok: false, statusCode: 'local', error: 'Tracker campaign ID unresolved for cost update' });
          return;
        }
        if (!Number.isFinite(cost)) {
          sendResponse?.({ ok: false, statusCode: 'local', error: 'Current spend is unavailable for this entity' });
          return;
        }
        const headers = {
          'Api-Key': tracker.apiToken,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        };
        const payload = buildTrackerCostPayload({ ...msg, entity: ctx.entity }, cost, ctx.entityId);
        const url = `${tracker.baseUrl}/public/api/v1/clicks/campaign/${encodeURIComponent(trackerCampaignId)}`;
        const result = await httpJsonMutation('tracker-update-cost', url, { method: 'PUT', headers, json: payload }, ctx.entityId || trackerCampaignId);
        log('ACTION update-cost success', {
          actionTraceId: msg.actionTraceId || null,
          trackerCampaignIdUsed: trackerCampaignId,
          sourceCampaignIdUsed: ctx.sourceCampaignId || '',
          statusCode: result.status
        });
        sendResponse?.({
          ok: true,
          action: 'update_cost',
          actionTraceId: msg.actionTraceId || null,
          entity: ctx.entity,
          statusCode: result.status,
          spentUsed: cost,
          trackerCampaignIdUsed: trackerCampaignId,
          sourceCampaignIdUsed: ctx.sourceCampaignId || ''
        });
      } catch (err) {
        log('ACTION update-cost error', {
          actionTraceId: msg.actionTraceId || null,
          statusCode: err?.status ?? 'request',
          error: String(err?.message || err || 'Request failed')
        });
        sendResponse?.({
          ok: false,
          action: 'update_cost',
          actionTraceId: msg.actionTraceId || null,
          statusCode: err?.status ?? 'request',
          error: String(err?.message || err || 'Request failed')
        });
      }
    })();
    return true;
  }

  if (msg && (msg.type === 'AK_ACTION_SET_CAMPAIGN_STATUS' || msg.type === 'AK_ACTION_SET_TEASER_STATUS')) {
    __lastDebugTabId = sender?.tab?.id || null;
    (async () => {
      try {
        log('ACTION toggle-status start', {
          actionTraceId: msg.actionTraceId || null,
          type: msg.type,
          entity: msg.entity || null,
          id: msg.id || null,
          trackerCampaignId: msg.trackerCampaignId || null,
          sourceCampaignId: msg.sourceCampaignId || msg.campaignId || null,
          whetherToBlockByClient: msg.whetherToBlockByClient
        });
        const ctx = await resolveActionContext(msg);
        log('ACTION toggle-status resolved', {
          actionTraceId: msg.actionTraceId || null,
          ctx
        });
        const desiredBlockValue = Number(msg.whetherToBlockByClient) === 1 ? 1 : 0;
        const creds = await loadSourceCredentials({
          trafficSourceId: ctx.trafficSourceId,
          trackerCampaignId: ctx.trackerCampaignId,
          sourceCampaignId: ctx.sourceCampaignId
        });
        const token = creds?.token;
        const idAuth = creds?.idAuth;
        const apiBase = creds?.apiBase || 'https://api.adskeeper.co.uk/v1';
        if (!token || !idAuth) {
          sendResponse?.({ ok: false, statusCode: 'local', error: 'Missing AdsKeeper credentials in Options' });
          return;
        }
        const headers = {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        };
        const isCampaign = msg.type === 'AK_ACTION_SET_CAMPAIGN_STATUS';
        const targetId = isCampaign ? String(ctx.sourceCampaignId || '').trim() : String(ctx.entityId || '').trim();
        if (!targetId) {
          sendResponse?.({ ok: false, statusCode: 'local', error: isCampaign ? 'Source campaign ID unresolved' : 'Teaser ID unresolved' });
          return;
        }
        const url = isCampaign
          ? `${apiBase}/goodhits/clients/${encodeURIComponent(idAuth)}/campaigns/${encodeURIComponent(targetId)}`
          : `${apiBase}/goodhits/clients/${encodeURIComponent(idAuth)}/teasers/${encodeURIComponent(targetId)}`;
        const result = await httpJsonMutation(
          isCampaign ? 'adskeeper-campaign-status' : 'adskeeper-teaser-status',
          url,
          { method: 'PATCH', headers, json: { whetherToBlockByClient: desiredBlockValue } },
          targetId
        );
        log('ACTION toggle-status success', {
          actionTraceId: msg.actionTraceId || null,
          type: msg.type,
          targetId,
          trackerCampaignIdUsed: ctx.trackerCampaignId || '',
          sourceCampaignIdUsed: ctx.sourceCampaignId || '',
          statusCode: result.status,
          newStatus: desiredBlockValue === 1 ? 'blocked' : 'active'
        });
        sendResponse?.({
          ok: true,
          action: isCampaign ? 'set_campaign_status' : 'set_teaser_status',
          actionTraceId: msg.actionTraceId || null,
          entity: isCampaign ? 'campaign' : 'teaser',
          statusCode: result.status,
          newStatus: desiredBlockValue === 1 ? 'blocked' : 'active',
          trackerCampaignIdUsed: ctx.trackerCampaignId || '',
          sourceCampaignIdUsed: ctx.sourceCampaignId || '',
          teaserIdUsed: isCampaign ? '' : targetId
        });
      } catch (err) {
        log('ACTION toggle-status error', {
          actionTraceId: msg.actionTraceId || null,
          type: msg.type,
          statusCode: err?.status ?? 'request',
          error: String(err?.message || err || 'Request failed')
        });
        sendResponse?.({
          ok: false,
          action: msg.type === 'AK_ACTION_SET_CAMPAIGN_STATUS' ? 'set_campaign_status' : 'set_teaser_status',
          actionTraceId: msg.actionTraceId || null,
          statusCode: err?.status ?? 'request',
          error: String(err?.message || err || 'Request failed')
        });
      }
    })();
    return true;
  }

if (msg && msg.type === 'AK_FETCH_ENTITY') {
  __lastDebugTabId = sender?.tab?.id || null;
  const entity = msg.entity === 'widget' ? 'widget' : (msg.entity === 'campaign' ? 'campaign' : 'teaser');
  const entityId = String(msg.id || '');
  let campaignId = String(msg.sourceCampaignId || msg.campaignId || '').trim();
  const trackerCampaignId = String(msg.trackerCampaignId || '');
  const trackerCampaignIds = uniqueStrings(msg.trackerCampaignIds || []);
  const trafficSourceId = String(msg.trafficSourceId || '');
  const entityGrouping = String(msg.entityGrouping || '').trim();
  const campaignScopeKind = String(msg.campaignScopeKind || '').trim();
  const startDate = msg.startDate || '';
  const endDate = msg.endDate || '';
  const timeZone = msg.timeZone || '';
  const dateType = msg.dateType || '';
  log('AK_FETCH_ENTITY request', {
    fromTab: sender?.tab?.id,
    actionTraceId: msg.actionTraceId || null,
    refreshReason: msg.refreshReason || null,
    entity,
    entityId,
    campaignId,
    trackerCampaignId,
    trackerCampaignIds,
    trafficSourceId,
    startDate,
    endDate,
    timeZone,
    dateType
  });
  debugToTab(__lastDebugTabId, 'AK_FETCH_ENTITY', { entity, entityId, campaignId, trackerCampaignId, trackerCampaignIds, trafficSourceId, entityGrouping, campaignScopeKind, startDate, endDate, timeZone, dateType });
  if (!entityId || (!campaignId && !trackerCampaignIds.length)) {
    sendResponse?.({ ok: false, error: 'Missing entity id or campaign id' });
    return true;
  }
  (async () => {
    try {
      const scope = { startDate, endDate, timeZone, dateType };
      let resolvedTrafficSourceId = trafficSourceId;
      let effectiveTrackerCampaignId = trackerCampaignId;
      let effectiveSourceCampaignId = campaignId;

      if (entity === 'campaign') {
        if (campaignScopeKind === 'tracker' || entityGrouping === 'campaign') {
          effectiveSourceCampaignId = '';
        } else if (campaignScopeKind === 'source' || entityGrouping === 'token_3') {
          effectiveTrackerCampaignId = '';
        }

        if (!effectiveSourceCampaignId && effectiveTrackerCampaignId) {
          const mapping = await resolveTrackerCampaignMapping(effectiveTrackerCampaignId, scope);
          effectiveSourceCampaignId = String(mapping?.sourceCampaignId || '').trim();
          resolvedTrafficSourceId = String(mapping?.trafficSourceId || resolvedTrafficSourceId || '').trim();
        } else if (effectiveSourceCampaignId && !effectiveTrackerCampaignId && trackerCampaignIds.length) {
          const mapping = await resolveScopedSourceCampaignMapping(effectiveSourceCampaignId, trackerCampaignIds, scope);
          effectiveTrackerCampaignId = String(mapping?.trackerCampaignId || '').trim();
          resolvedTrafficSourceId = String(mapping?.trafficSourceId || resolvedTrafficSourceId || '').trim();
        }
        campaignId = effectiveSourceCampaignId;
      }

      if (!campaignId && entity === 'teaser' && trackerCampaignIds.length) {
        const teaserMapping = await resolveScopedTeaserCampaignMapping(entityId, trackerCampaignIds, scope);
        if (!teaserMapping?.sourceCampaignId) {
          sendResponse?.({ ok: false, error: 'Failed to resolve tracker campaign for teaser in current report scope' });
          return;
        }
        campaignId = teaserMapping.sourceCampaignId;
        resolvedTrafficSourceId = teaserMapping.trafficSourceId || resolvedTrafficSourceId;
      }

      if (effectiveTrackerCampaignId && globalThis.BMSecureStorage?.saveCampaignResolution) {
        await globalThis.BMSecureStorage.saveCampaignResolution({
          trackerCampaignId: effectiveTrackerCampaignId,
          trafficSourceId: String(resolvedTrafficSourceId || trafficSourceId || ''),
          sourceCampaignId: campaignId,
          resolutionSource: 'content_page_meta',
          apiAttempts: 0,
          updatedAt: Date.now()
        });
      }
      let data = null;
      let responseMetaExtra = {};
      if (entity === 'widget') {
        const widgetMappings = trackerCampaignIds.length
          ? await resolveScopedWidgetCampaignMappings(entityId, trackerCampaignIds, scope)
          : [];
        const mappingList = widgetMappings.length
          ? widgetMappings
          : [{ trackerCampaignId, trafficSourceId: resolvedTrafficSourceId, sourceCampaignId: campaignId }];
        const widgetParts = [];
        const widgetTrackerCampaignIdsUsed = [];
        const widgetSourceCampaignIdsUsed = [];
        for (const mapping of mappingList) {
          if (!mapping?.sourceCampaignId) continue;
          widgetTrackerCampaignIdsUsed.push(String(mapping.trackerCampaignId || ''));
          widgetSourceCampaignIdsUsed.push(String(mapping.sourceCampaignId || ''));
          const creds = await loadSourceCredentials({ trafficSourceId: mapping.trafficSourceId, trackerCampaignId: mapping.trackerCampaignId, sourceCampaignId: mapping.sourceCampaignId });
          const token = creds?.token;
          const idAuth = creds?.idAuth;
          const apiBase = creds?.apiBase || 'https://api.adskeeper.co.uk/v1';
          if (!token || !idAuth) continue;
          const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
          const campaignDetails = await fetchCampaignDetails(apiBase, idAuth, headers, mapping.sourceCampaignId).catch(() => null);
          const widgetAcl = extractCampaignWidgetAcl(campaignDetails);
          const metrics = await fetchWidgetsQualityStats(apiBase, mapping.sourceCampaignId, headers, [entityId], startDate, endDate, widgetAcl, timeZone, dateType, { stream: false });
          const entry = metrics?.[entityId] || {};
          const widgetStatus = entry.status ?? deriveWidgetStatusFromAcl(widgetAcl, entityId) ?? null;
          widgetParts.push({
            impressions: entry.impressions ?? null,
            clicks: entry.clicks ?? null,
            spend: entry.spend ?? null,
            cpc: entry.cpc ?? null,
            bid: entry.bid ?? null,
            status: widgetStatus
          });
        }
        data = aggregateMetrics(widgetParts);
        responseMetaExtra = {
          trackerCampaignIdsUsed: uniqueStrings(widgetTrackerCampaignIdsUsed),
          sourceCampaignIdsUsed: uniqueStrings(widgetSourceCampaignIdsUsed)
        };
      } else if (entity === 'campaign') {
        const creds = await loadSourceCredentials({ ...msg, trafficSourceId: resolvedTrafficSourceId, sourceCampaignId: campaignId, campaignId });
        const token = creds?.token;
        const idAuth = creds?.idAuth;
        const apiBase = creds?.apiBase || 'https://api.adskeeper.co.uk/v1';
        if (!token || !idAuth) {
          sendResponse?.({ ok: false, error: 'Missing Adskeeper credentials in Options' });
          return;
        }
        const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
        const details = campaignId ? await fetchCampaignDetails(apiBase, idAuth, headers, campaignId).catch(() => null) : null;
        const stats = campaignId ? await fetchCampaignStats(apiBase, idAuth, headers, [campaignId], startDate, endDate, timeZone, dateType) : {};
        const metric = campaignId ? (stats?.[campaignId] || {}) : {};
        data = {
          impressions: metric.impressions ?? null,
          clicks: metric.clicks ?? null,
          spend: metric.spend ?? null,
          cpc: metric.cpc ?? null,
          bid: metric.bid ?? null,
          status: metric.status ?? extractStatusCode(details?.status) ?? extractStatusReason(details?.status) ?? null
        };
        responseMetaExtra = {
          trackerCampaignIdsUsed: uniqueStrings([effectiveTrackerCampaignId].filter(Boolean)),
          sourceCampaignIdsUsed: uniqueStrings([campaignId].filter(Boolean))
        };
      } else {
        const creds = await loadSourceCredentials({ ...msg, trafficSourceId: resolvedTrafficSourceId, sourceCampaignId: campaignId, campaignId });
        const token = creds?.token;
        const idAuth = creds?.idAuth;
        const apiBase = creds?.apiBase || 'https://api.adskeeper.co.uk/v1';
        if (!token || !idAuth) {
          sendResponse?.({ ok: false, error: 'Missing Adskeeper credentials in Options' });
          return;
        }
        const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
        const teaserMap = await listTeasersById(apiBase, idAuth, headers, campaignId).catch(() => ({}));
        const teaserDetails = teaserMap?.[entityId] || null;
        const campaignDetails = campaignId ? await fetchCampaignDetails(apiBase, idAuth, headers, campaignId).catch(() => null) : null;
        const stats = await fetchTeasersStats(apiBase, idAuth, headers, [entityId], startDate, endDate, campaignId, timeZone, dateType);
        const metric = stats?.[entityId] || {};
        data = {
          impressions: metric.impressions ?? null,
          clicks: metric.clicks ?? null,
          spend: metric.spend ?? null,
          cpc: metric.cpc ?? null,
          bid: metric.bid ?? extractCurrentBid(teaserDetails),
          status: metric.status ?? teaserDetails?.status?.code ?? teaserDetails?.status ?? null,
          campaignStatus: extractStatusCode(campaignDetails?.status) ?? extractStatusReason(campaignDetails?.status) ?? null
        };
      }
      const rangeInfo = { startDate, endDate };
      if (timeZone) rangeInfo.timeZone = timeZone;
      if (dateType) rangeInfo.dateType = dateType;
      const metaInfo = {
        campaignId: entity === 'widget' && trackerCampaignIds.length ? '' : campaignId,
        startDate,
        endDate,
        trackerCampaignIdsKey: serializeTrackerCampaignIds(trackerCampaignIds),
        ...responseMetaExtra
      };
      if (timeZone) metaInfo.timeZone = timeZone;
      if (dateType) metaInfo.dateType = dateType;
      log('AK_FETCH_ENTITY success', {
        actionTraceId: msg.actionTraceId || null,
        refreshReason: msg.refreshReason || null,
        entity,
        entityId,
        responseMeta: metaInfo,
        hasData: !!data
      });
      sendResponse?.({ ok: true, data, entity, id: entityId, range: rangeInfo, meta: metaInfo, actionTraceId: msg.actionTraceId || null });
    } catch (err) {
      console.error('[BinomMagicDemo] AK_FETCH_ENTITY error', err);
      log('AK_FETCH_ENTITY error', {
        actionTraceId: msg.actionTraceId || null,
        refreshReason: msg.refreshReason || null,
        entity,
        entityId,
        error: String(err && err.message || err)
      });
      sendResponse?.({ ok: false, error: String(err && err.message || err), actionTraceId: msg.actionTraceId || null });
    }
  })();
  return true;
}

  if (msg && msg.type === 'AK_FETCH_METRICS') {
    __lastDebugTabId = sender?.tab?.id || null;
    log('AK_FETCH_METRICS request', {
      fromTab: sender?.tab?.id,
      params: { campaignId: msg.campaignId, sourceCampaignId: msg.sourceCampaignId || '', trackerCampaignId: msg.trackerCampaignId || '', trafficSourceId: msg.trafficSourceId || '', startDate: msg.startDate, endDate: msg.endDate, teaserCount: (msg.teaserIds||[]).length, widgetCount: (msg.widgetIds||[]).length, campaignCount: (msg.campaignIds||[]).length, timeZone: msg.timeZone || '', dateType: msg.dateType || '' }
    });
    debugToTab(__lastDebugTabId, 'AK_FETCH_METRICS', {
      campaignId: msg.campaignId,
      sourceCampaignId: msg.sourceCampaignId || '',
      trackerCampaignId: msg.trackerCampaignId || '',
      trafficSourceId: msg.trafficSourceId || '',
      startDate: msg.startDate,
      endDate: msg.endDate,
      teaserIds: msg.teaserIds || [],
      widgetIds: msg.widgetIds || [],
      campaignIds: msg.campaignIds || [],
      timeZone: msg.timeZone || '', dateType: msg.dateType || ''
    });
    // Reactive-only: fetch Adskeeper metrics on demand using stored credentials
    (async () => {
      try {
        const { campaignId, sourceCampaignId = '', trackerCampaignId = '', trafficSourceId = '', startDate, endDate, timeZone = '', dateType = '', teaserIds, widgetIds, campaignIds, hasTeasers } = msg;
        const effectiveCampaignId = String(sourceCampaignId || campaignId || '');
        const creds = await loadSourceCredentials(msg);
        const token = creds?.token;
        const idAuth = creds?.idAuth;
        const apiBase = creds?.apiBase || 'https://api.adskeeper.co.uk/v1';
        if (!token || !idAuth) {
          sendResponse({ ok: false, error: 'Missing Adskeeper credentials in Options' });
          return;
        }
        if (trackerCampaignId && globalThis.BMSecureStorage?.saveCampaignResolution) {
          await globalThis.BMSecureStorage.saveCampaignResolution({
            trackerCampaignId,
            trafficSourceId: String(creds?.trackerId || trafficSourceId || ''),
            sourceCampaignId: effectiveCampaignId,
            resolutionSource: 'content_page_meta',
            apiAttempts: 0,
            updatedAt: Date.now()
          });
        }

        const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };

        // Preload campaign details to derive widget allow/deny list for status enrichment
        let campaignDetails = null;
        try {
          campaignDetails = await fetchCampaignDetails(apiBase, idAuth, headers, effectiveCampaignId);
        } catch (e) {
          debugToTab(__lastDebugTabId, 'CAMPAIGN_DETAILS_ERROR', { error: String(e && e.message || e) });
        }
        const widgetAcl = extractCampaignWidgetAcl(campaignDetails);
        let teaserMap = {};
        let targetIds = Array.isArray(teaserIds) ? teaserIds : [];
        if (hasTeasers && !targetIds.length && campaignId) {
          try {
            teaserMap = await listTeasersById(apiBase, idAuth, headers, effectiveCampaignId);
            log('Teasers listed', { campaignId: effectiveCampaignId, count: Object.keys(teaserMap).length, keysSample: Object.keys(teaserMap).slice(0,10) });
            debugToTab(__lastDebugTabId, 'TEASERS_LISTED', { campaignId: effectiveCampaignId, count: Object.keys(teaserMap).length, keysSample: Object.keys(teaserMap).slice(0,10) });
            targetIds = Object.keys(teaserMap);
          } catch (e) {
            log('Teasers list skipped/failed', String(e && e.message || e));
            debugToTab(__lastDebugTabId, 'TEASERS_LIST_ERROR', { error: String(e && e.message || e) });
          }
        }
        let metrics = {};
        if (hasTeasers && targetIds.length) {
          metrics = await fetchTeasersStats(apiBase, idAuth, headers, targetIds, startDate, endDate, effectiveCampaignId, timeZone, dateType);
          log('Teaser stats fetched', { requested: targetIds.length, haveMetrics: Object.keys(metrics).length, requestedSample: targetIds.slice(0,10), metricKeysSample: Object.keys(metrics).slice(0,10) });
          debugToTab(__lastDebugTabId, 'TEASER_STATS_SUMMARY', { requested: targetIds.length, haveMetrics: Object.keys(metrics).length, requestedSample: targetIds.slice(0,10), metricKeysSample: Object.keys(metrics).slice(0,10) });
        } else {
          log('Teaser stats skipped (no teaserIds)');
          debugToTab(__lastDebugTabId, 'TEASER_STATS_SKIPPED', {});
        }

        // Merge teaser object fields (bid/status) with stats metrics
        const result = {};
        const rangeInfo = { startDate: toDateOnly(startDate), endDate: toDateOnly(endDate) };
        if (timeZone) rangeInfo.timeZone = timeZone;
        if (dateType) rangeInfo.dateType = dateType;
        const metaBase = { campaignId };
        if (timeZone) metaBase.timeZone = timeZone;
        if (dateType) metaBase.dateType = dateType;
        for (const tid of targetIds) {
          const t = teaserMap[tid] || {};
          const m = metrics[tid] || {};
          result[tid] = {
            impressions: m.impressions ?? null,
            clicks: m.clicks ?? null,
            spend: m.spend ?? null,
            cpc: (m.clicks > 0 && m.spend != null) ? (m.spend / m.clicks) : (m.cpc ?? null),
            bid: extractCurrentBid(t),
            status: (t && t.status && t.status.code) || null,
          };
          log('Merged metric', { tid, merged: result[tid] });
          emitMetricToTab('teaser', tid, result[tid], { range: rangeInfo, meta: metaBase });
        }
        // Widgets: use campaign quality-analysis per widget uid
        let widgetResult = {};
        if (Array.isArray(widgetIds) && widgetIds.length) {
          const wTarget = widgetIds.map(String);
          const wMetrics = await fetchWidgetsQualityStats(apiBase, effectiveCampaignId, headers, wTarget, startDate, endDate, widgetAcl, timeZone, dateType);
          log('Widget quality-analysis fetched', { requested: wTarget.length, haveMetrics: Object.keys(wMetrics).length, requestedSample: wTarget.slice(0,10), metricKeysSample: Object.keys(wMetrics).slice(0,10) });
          debugToTab(__lastDebugTabId, 'WIDGET_QA_SUMMARY', { requested: wTarget.length, haveMetrics: Object.keys(wMetrics).length, requestedSample: wTarget.slice(0,10), metricKeysSample: Object.keys(wMetrics).slice(0,10) });
          const wRes = {};
          const widgetRange = { startDate: toDateOnly(startDate), endDate: toDateOnly(endDate) };
          if (timeZone) widgetRange.timeZone = timeZone;
          if (dateType) widgetRange.dateType = dateType;
          for (const wid of wTarget) {
            const m = { ...(wMetrics[wid] || {}) };
            if (!m.status) m.status = deriveWidgetStatusFromAcl(widgetAcl, wid);
            wRes[wid] = {
              impressions: m.impressions ?? null,
              clicks: m.clicks ?? null,
              spend: m.spend ?? null,
              cpc: (m.clicks > 0 && m.spend != null) ? (m.spend / m.clicks) : (m.cpc ?? null),
              bid: null,
              status: m.status ?? null,
            };
            log('Merged widget metric', { wid, merged: wRes[wid] });
            emitMetricToTab('widget', wid, wRes[wid], { range: widgetRange, meta: metaBase });
          }
          widgetResult = wRes;
        }

        let campaignResult = {};
        if (Array.isArray(campaignIds) && campaignIds.length) {
          const cTarget = Array.from(new Set(campaignIds.map(String)));
          const cMetrics = await fetchCampaignStats(apiBase, idAuth, headers, cTarget, startDate, endDate, timeZone, dateType);
          log('Campaign stats fetched', { requested: cTarget.length, haveMetrics: Object.keys(cMetrics).length, requestedSample: cTarget.slice(0,10), metricKeysSample: Object.keys(cMetrics).slice(0,10) });
          debugToTab(__lastDebugTabId, 'CAMPAIGN_STATS_SUMMARY', { requested: cTarget.length, haveMetrics: Object.keys(cMetrics).length, requestedSample: cTarget.slice(0,10), metricKeysSample: Object.keys(cMetrics).slice(0,10) });
          const cRes = {};
          const campaignRange = { startDate: toDateOnly(startDate), endDate: toDateOnly(endDate) };
          if (timeZone) campaignRange.timeZone = timeZone;
          if (dateType) campaignRange.dateType = dateType;
          for (const cid of cTarget) {
            const m = { ...(cMetrics[cid] || {}) };
            cRes[cid] = {
              impressions: m.impressions ?? null,
              clicks: m.clicks ?? null,
              spend: m.spend ?? null,
              cpc: (m.clicks > 0 && m.spend != null) ? (m.spend / m.clicks) : (m.cpc ?? null),
              bid: m.bid ?? null,
              status: m.status ?? null,
            };
            log('Merged campaign metric', { cid, merged: cRes[cid] });
            emitMetricToTab('campaign', cid, cRes[cid], { range: campaignRange, meta: { campaignId: cid, timeZone, dateType } });
          }
          campaignResult = cRes;
        }

        // Debug payload for client-side correlation
        const debug = {
          campaignIdUsed: campaignId,
          sDate: toDateOnly(startDate), eDate: toDateOnly(endDate),
          timeZoneUsed: timeZone || '', dateTypeUsed: dateType || '',
          teaserIdsRequested: Array.isArray(teaserIds) ? teaserIds : [],
          teaserIdsWithMetrics: Object.keys(metrics || {}),
          widgetIdsRequested: Array.isArray(widgetIds) ? widgetIds : [],
          widgetIdsWithMetrics: Object.keys(widgetResult || {}),
          campaignIdsRequested: Array.isArray(campaignIds) ? campaignIds : [],
          campaignIdsWithMetrics: Object.keys(campaignResult || {}),
        };

        const responseRange = { startDate, endDate };
        if (timeZone) responseRange.timeZone = timeZone;
        if (dateType) responseRange.dateType = dateType;
        const responseMeta = { campaignId };
        if (timeZone) responseMeta.timeZone = timeZone;
        if (dateType) responseMeta.dateType = dateType;
        sendResponse({ ok: true, data: result, widgets: widgetResult, campaigns: campaignResult, range: responseRange, meta: responseMeta, debug });
      } catch (err) {
        console.error('[BinomMagicDemo] AK_FETCH_METRICS error', err);
        debugToTab(__lastDebugTabId, 'AK_FETCH_METRICS_ERROR', { error: String(err && err.message || err) });
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true; // keep port open for async sendResponse
  }
});

// Toolbar button fallback
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    // Guard against chrome:// pages where injection is not allowed
    const url = tab.url || (await chrome.tabs.get(tab.id)).url || '';
    if (!/^https?:|^file:/.test(url)) {
      // On unsupported pages, open options instead of throwing
      await chrome.runtime.openOptionsPage?.();
      return;
    }
  } catch (_) {
    // If we cannot read URL (permissions), still try safe path below
  }

  try {
    log('Action clicked: inject live', { tabId: tab.id, url: tab.url });
    await chrome.tabs.sendMessage(tab.id, { type: 'BINOM_MAGIC_INJECT_LIVE' });
  } catch (e) {
    try {
      // Programmatic injection requires host permission; will no-op on chrome://
      log('Programmatic injection attempt for content script');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/binom-demo.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'BINOM_MAGIC_INJECT_LIVE' });
    } catch (err) {
      // Common on chrome:// pages; ignore and optionally open options as guidance
      console.error('[BinomMagicDemo] action click failed:', err);
      try { await chrome.runtime.openOptionsPage?.(); } catch (_) {}
    }
  }
});

// Keyboard shortcut fallback
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'binom_magic_copy_ids') return;
  const activeTab = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!activeTab?.id) return;
  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: 'BINOM_MAGIC_COPY_IDS' });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content/binom-demo.js'] });
      await chrome.tabs.sendMessage(activeTab.id, { type: 'BINOM_MAGIC_COPY_IDS' });
    } catch (err) {
      console.error('[BinomMagicDemo] command failed:', err);
    }
  }
});

// --- Helpers: Adskeeper API minimal client (reactive on-demand) ---
async function listTeasersById(apiBase, idAuth, headers, campaignId) {
  // TODO(ru/en): Реализовать пагинацию вместо фиксированного limit=1000.
  // Иначе часть teaser-ов не попадёт в индекс на больших кампаниях.
  // Implement pagination instead of a fixed limit=1000.
  // Otherwise part of the teaser set will be missing on large campaigns.
  const url = `${apiBase}/goodhits/clients/${encodeURIComponent(idAuth)}/teasers?campaign=${encodeURIComponent(String(campaignId))}&limit=1000`;
  log('GET teasers', { url, headers: redactAuth(headers) });
  const data = await httpJsonWithRetries('teasers', url, headers);
  if (Array.isArray(data)) {
    const idx = {};
    data.forEach(t => { const id = String(t?.id ?? t?.teaserId ?? t?.teaser_id ?? ''); if (id) idx[id] = t; });
    return idx;
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.teasers)) {
      const idx = {};
      data.teasers.forEach(t => { const id = String(t?.id ?? t?.teaserId ?? t?.teaser_id ?? ''); if (id) idx[id] = t; });
      return idx;
    }
    // Already id->object map
    return Object.fromEntries(Object.entries(data).map(([k,v]) => [String(k), v]));
  }
  return {};
}

async function fetchTeasersStats(apiBase, idAuth, headers, teaserIds, startDate, endDate, campaignId = null, timeZone = '', dateType = '') {
  const result = {};
  const ids = Array.from(new Set(teaserIds.map(String)));
  // TODO(ru/en): Сейчас это N запросов по одному teaser.
  // Для крупных таблиц нужен batch/API-side aggregation или более умная очередь.
  // This is currently N one-request-per-teaser calls.
  // Large tables need batch/API-side aggregation or a smarter queue.
  // Concurrency 3, pause 330ms after each batch of 3
  const queue = ids.slice();
  let processed = 0;
  const workers = Array.from({ length: 3 }, () => worker());
  await Promise.all(workers);
  return result;

  async function worker() {
    while (queue.length) {
      const tid = queue.shift();
      try {
        const sDate = toDateOnly(startDate); const eDate = toDateOnly(endDate);
        const url = `${apiBase}/goodhits/clients/${encodeURIComponent(idAuth)}/teaser-stat/${encodeURIComponent(tid)}?dateInterval=interval&startDate=${encodeURIComponent(sDate)}&endDate=${encodeURIComponent(eDate)}`;
        log('GET teaser-stat', { tid, url, headers: redactAuth(headers) });
        debugToTab(__lastDebugTabId, 'REQUEST', { kind: 'teaser-stat', tid, url, headers: redactAuth(headers) });
        const payload = await httpJsonWithRetries('teaser-stat', url, headers, tid);
        const norm = normalizeTeaserStats(payload);
        result[tid] = norm;
        log('Parsed teaser-stat', { tid, parsed: norm });
        debugToTab(__lastDebugTabId, 'PARSED', { kind: 'teaser-stat', tid, parsed: norm });
        const streamRange = { startDate: sDate, endDate: eDate };
        if (timeZone) streamRange.timeZone = timeZone;
        if (dateType) streamRange.dateType = dateType;
        const streamMeta = { campaignId };
        if (timeZone) streamMeta.timeZone = timeZone;
        if (dateType) streamMeta.dateType = dateType;
        emitMetricToTab('teaser', tid, norm, { range: streamRange, meta: streamMeta });
      } catch (e) {
        console.warn('[BinomMagicDemo] teaser stat failed for', tid, e);
        debugToTab(__lastDebugTabId, 'ERROR', { kind: 'teaser-stat', tid, error: String(e && e.message || e) });
      }
      processed += 1;
      if (processed % 3 === 0) {
        await new Promise(r => setTimeout(r, 790));
      }
    }
  }
}

async function listWidgetsById(apiBase, idAuth, headers, campaignId) {
  const url = `${apiBase}/goodhits/clients/${encodeURIComponent(idAuth)}/widgets?campaign=${encodeURIComponent(String(campaignId))}&limit=1000`;
  log('GET widgets', { url, headers: redactAuth(headers) });
  const data = await httpJsonWithRetries('widgets', url, headers);
  if (Array.isArray(data)) {
    const idx = {};
    data.forEach(t => { const id = String(t?.id ?? t?.widgetId ?? t?.widget_id ?? ''); if (id) idx[id] = t; });
    return idx;
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.widgets)) {
      const idx = {};
      data.widgets.forEach(t => { const id = String(t?.id ?? t?.widgetId ?? t?.widget_id ?? ''); if (id) idx[id] = t; });
      return idx;
    }
    // Already id->object map
    return Object.fromEntries(Object.entries(data).map(([k,v]) => [String(k), v]));
  }
  return {};
}

// (removed) fetchWidgetsStats was unused and referenced undefined vars (timeZone/dateType/campaignId).
// Use fetchWidgetsQualityStats(...) instead for widget metrics.

async function fetchCampaignStats(apiBase, idAuth, headers, campaignIds, startDate, endDate, timeZone = '', dateType = '') {
  const ids = Array.from(new Set((campaignIds || []).map(String).filter(Boolean)));
  if (!ids.length) return {};
  const sDate = toDateOnly(startDate);
  const eDate = toDateOnly(endDate);
  const query = new URLSearchParams({
    dateInterval: 'interval',
    startDate: sDate,
    endDate: eDate
  });
  if (timeZone) query.set('timeZone', timeZone);
  if (dateType) query.set('dateType', dateType);
  const url = `${apiBase}/goodhits/clients/${encodeURIComponent(idAuth)}/campaigns-stat?${query.toString()}`;
  log('GET campaigns-stat', { campaignIds: ids, url, headers: redactAuth(headers) });
  debugToTab(__lastDebugTabId, 'REQUEST', { kind: 'campaigns-stat', campaignIds: ids, url, headers: redactAuth(headers) });
  const payload = await httpJsonWithRetries('campaigns-stat', url, headers, ids.join(','));
  const result = mapCampaignStats(payload, ids);
  const streamRange = { startDate: sDate, endDate: eDate };
  if (timeZone) streamRange.timeZone = timeZone;
  if (dateType) streamRange.dateType = dateType;
  for (const id of ids) {
    if (result[id]) {
      emitMetricToTab('campaign', id, result[id], { range: streamRange, meta: { campaignId: id, timeZone, dateType } });
    }
  }
  return result;
}

// Fetch widget metrics via campaign quality-analysis/{uid}
async function fetchWidgetsQualityStats(apiBase, campaignId, headers, widgetIds, startDate, endDate, widgetAcl, timeZone = '', dateType = '', options = {}) {
  const { stream = true, streamEntityId = null, streamMeta = null } = options || {};
  const result = {};
  const ids = Array.from(new Set(widgetIds.map(String)));
  const queue = ids.slice();
  let processed = 0;
  const workers = Array.from({ length: 3 }, () => worker());
  await Promise.all(workers);
  return result;

  async function worker() {
    while (queue.length) {
      const wid = queue.shift();
      try {
        const sDate = toDateOnly(startDate); const eDate = toDateOnly(endDate);
        const url = `${apiBase}/goodhits/campaigns/${encodeURIComponent(String(campaignId))}/quality-analysis/${encodeURIComponent(String(wid))}?dateInterval=interval&startDate=${encodeURIComponent(sDate)}&endDate=${encodeURIComponent(eDate)}`;
        log('GET quality-analysis', { wid, url, headers: redactAuth(headers) });
        debugToTab(__lastDebugTabId, 'REQUEST', { kind: 'quality-analysis', wid, url, headers: redactAuth(headers) });
        const payload = await httpJsonWithRetries('quality-analysis', url, headers, wid);
        const norm = normalizeTeaserStats(payload);
        if (widgetAcl && widgetAcl.mode) {
          const inSet = widgetAcl.ids && widgetAcl.ids.has(String(wid));
          if (inSet && !norm.status) norm.status = widgetAcl.mode === 'include' ? 'included' : 'excluded';
        }
        result[wid] = norm;
        log('Parsed quality-analysis', { wid, parsed: norm });
        debugToTab(__lastDebugTabId, 'PARSED', { kind: 'quality-analysis', wid, parsed: norm });
        // Status can be enriched by ACL externally; streaming emit here
        const streamRange = { startDate: sDate, endDate: eDate };
        if (timeZone) streamRange.timeZone = timeZone;
        if (dateType) streamRange.dateType = dateType;
        const streamMeta = { campaignId };
        if (timeZone) streamMeta.timeZone = timeZone;
        if (dateType) streamMeta.dateType = dateType;
        if (stream) {
          emitMetricToTab('widget', streamEntityId || wid, norm, { range: streamRange, meta: streamMeta || { campaignId } });
        }
      } catch (e) {
        console.warn('[BinomMagicDemo] quality-analysis failed for', wid, e);
        debugToTab(__lastDebugTabId, 'ERROR', { kind: 'quality-analysis', wid, error: String(e && e.message || e) });
      }
      processed += 1;
      if (processed % 3 === 0) {
        await new Promise(r => setTimeout(r, 330));
      }
    }
  }
}

async function fetchCampaignDetails(apiBase, idAuth, headers, campaignId) {
  // Try specific campaign endpoint first; fall back to list and filter
  let url = `${apiBase}/goodhits/clients/${encodeURIComponent(idAuth)}/campaigns/${encodeURIComponent(String(campaignId))}`;
  log('GET campaign details', { url, headers: redactAuth(headers) });
  let data = await httpJsonWithRetries('campaign', url, headers);
  if (data) return data;
  // TODO(ru/en): Fallback "list all and filter client-side" плохо масштабируется
  // и также режется limit=1000. Нужен paged lookup или другой серверный endpoint.
  // The "list all and filter client-side" fallback scales poorly
  // and is also capped by limit=1000. A paged lookup or another server-side endpoint is needed.
  // Fallback to listing all (heavier) and picking our id
  url = `${apiBase}/goodhits/clients/${encodeURIComponent(idAuth)}/campaigns?start=1&limit=1000`;
  log('GET campaigns (fallback)', { url, headers: redactAuth(headers) });
  data = await httpJsonWithRetries('campaigns', url, headers);
  if (!data) throw new Error('campaigns fetch failed');
  // data may be an object keyed by id
  if (typeof data === 'object') {
    if (data[String(campaignId)]) return data[String(campaignId)];
    // or array
    if (Array.isArray(data)) {
      const found = data.find(x => String(x?.id) === String(campaignId));
      if (found) return found;
    }
  }
  return {};
}

function extractWidgetStatusFromCampaign(payload, wid) {
  try {
    const targetId = String(wid);
    let foundStatus = null;
    const walk = (node) => {
      if (!node || foundStatus) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node === 'object') {
        const idMatch = ['id','widgetId','widget_id','uid'].some(k => String(node[k]) === targetId);
        if (idMatch) {
          if (node.status && typeof node.status === 'string') { foundStatus = node.status; return; }
          if (node.status && typeof node.status === 'object' && node.status.code) { foundStatus = String(node.status.code); return; }
        }
        Object.values(node).forEach(walk);
      }
    };
    walk(payload);
    return foundStatus;
  } catch (_) { return null; }
}

function extractCampaignWidgetAcl(payload) {
  try {
    if (!payload || typeof payload !== 'object') return null;
    const wfu = payload.widgetsFilterUid || payload.widgetsFilter || null;
    if (!wfu || typeof wfu !== 'object') return null;
    const filterType = String(wfu.filterType || '').toLowerCase();
    const widgetsObj = wfu.widgets && typeof wfu.widgets === 'object' ? wfu.widgets : null;
    if (!widgetsObj) return null;
    const ids = new Set(Object.keys(widgetsObj).map(String).filter(s => /^\d{4,}$/.test(s)));
    if (!ids.size) return null;
    // We only act on explicit filter types we understand
    if (filterType !== 'except' && filterType !== 'only') return { filterType: null, ids };
    return { filterType, ids };
  } catch (_) { return null; }
}

function deriveWidgetStatusFromAcl(widgetAcl, wid) {
  try {
    if (!widgetAcl || !widgetAcl.ids) return null;
    const inList = widgetAcl.ids.has(String(wid));
    if (widgetAcl.filterType === 'except') return inList ? 'off' : 'on';
    if (widgetAcl.filterType === 'only') return inList ? 'on' : 'off';
    return null;
  } catch (_) {
    return null;
  }
}

function extractRemoteErrorMessage(payload, fallbackText = '') {
  if (!payload) return fallbackText || 'Request failed';
  if (typeof payload === 'string') return payload || fallbackText || 'Request failed';
  if (Array.isArray(payload?.errors) && payload.errors.length) return payload.errors.map(String).join('; ');
  if (typeof payload?.error === 'string' && payload.error) return payload.error;
  if (typeof payload?.message === 'string' && payload.message) return payload.message;
  return fallbackText || 'Request failed';
}

async function httpJsonMutation(kind, url, { method = 'PATCH', headers = {}, json = null } = {}, idLabel = '') {
  const options = {
    method,
    headers: { ...headers }
  };
  if (json !== null && json !== undefined) {
    options.body = JSON.stringify(json);
  }
  debugToTab(__lastDebugTabId, 'REQUEST', { kind, id: idLabel, url, method, headers: redactAuth(headers), body: json || null });
  const resp = await fetch(url, options);
  const status = resp.status;
  const text = await resp.text();
  debugToTab(__lastDebugTabId, 'RESPONSE', { kind, id: idLabel, status, body: trunc(text) });
  // TODO(ru/en): Не пересылать debug body мутаций и ответы без дополнительной санации или feature-flag.
  // Иначе чувствительные данные могут попасть в консоль страницы.
  // Do not forward mutation debug bodies/responses without extra sanitization or a feature flag.
  // Otherwise sensitive data can leak into the page console.
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
  if (!resp.ok) {
    const error = new Error(extractRemoteErrorMessage(parsed, `${kind} ${status}`));
    error.status = status;
    error.payload = parsed;
    error.body = text;
    throw error;
  }
  return { status, data: parsed, text };
}

function extractStatusCode(status) {
  if (!status) return null;
  if (typeof status === 'string') return status;
  if (typeof status === 'object') {
    if (status.code != null && String(status.code).trim()) return String(status.code).trim();
    if (status.name != null && String(status.name).trim()) return String(status.name).trim();
    if (status.id != null && String(status.id).trim()) return String(status.id).trim();
  }
  return null;
}

function extractStatusReason(status) {
  if (!status || typeof status !== 'object') return null;
  return status.reason != null && String(status.reason).trim() ? String(status.reason).trim() : null;
}

function aggregateMetrics(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;
  let clicks = 0;
  let spend = 0;
  let impressions = 0;
  let hasClicks = false;
  let hasSpend = false;
  let hasImpressions = false;
  let bid = null;
  const statuses = new Set();

  for (const item of list) {
    const itemClicks = Number(item.clicks);
    if (Number.isFinite(itemClicks)) {
      clicks += itemClicks;
      hasClicks = true;
    }
    const itemSpend = Number(item.spend);
    if (Number.isFinite(itemSpend)) {
      spend += itemSpend;
      hasSpend = true;
    }
    const itemImpressions = Number(item.impressions);
    if (Number.isFinite(itemImpressions)) {
      impressions += itemImpressions;
      hasImpressions = true;
    }
    if (bid == null && item.bid != null) bid = item.bid;
    if (item.status != null && String(item.status).trim()) statuses.add(String(item.status).trim());
  }

  return {
    impressions: hasImpressions ? impressions : null,
    clicks: hasClicks ? clicks : null,
    spend: hasSpend ? spend : null,
    cpc: hasClicks && clicks > 0 && hasSpend ? (spend / clicks) : null,
    bid,
    status: statuses.size === 1 ? Array.from(statuses)[0] : (statuses.size > 1 ? 'mixed' : null)
  };
}

function normalizeTeaserStats(payload) {
  // Traverse to aggregate clicks and spend; fallback to avg cpc if present
  let clicks = 0, spend = 0, cpc = null, impr = 0;
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      for (const [k,v] of Object.entries(node)) {
        const kk = String(k).toLowerCase();
        if (kk === 'clicks') { const n = parseFloat(v); if (Number.isFinite(n)) clicks += n; }
        else if (kk === 'spent' || kk === 'cost' || kk === 'fundsearned' || kk === 'spend') { const n = parseFloat(v); if (Number.isFinite(n)) spend += n; }
        else if (kk === 'impressions' || kk === 'hits' || kk === 'shows' || kk === 'numberofshows' || kk === 'imps') { const n = parseFloat(v); if (Number.isFinite(n)) impr += n; }
        else if (kk === 'avcpc' || kk === 'avgcpc' || kk === 'cpc' || kk === 'averagecpc') { const n = parseFloat(v); if (Number.isFinite(n)) cpc = n; }
        else { walk(v); }
      }
    }
  };
  walk(payload);
  const out = { clicks, spend, impressions: impr };
  if (clicks > 0 && spend != null) out.cpc = spend / clicks; else if (cpc != null) out.cpc = cpc;
  return out;
}

function mapCampaignStats(payload, ids) {
  const result = {};
  const wanted = new Set(ids.map(String));
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object') return;
    const campaignId = extractCampaignStatsId(node);
    if (campaignId && wanted.has(campaignId) && !result[campaignId]) {
      result[campaignId] = normalizeTeaserStats(node);
      if (node.status) {
        result[campaignId].status = typeof node.status === 'object' ? (node.status.code ?? null) : node.status;
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(payload);
  return result;
}

function extractCampaignStatsId(node) {
  if (!node || typeof node !== 'object') return null;
  const candidates = [
    node.id,
    node.campaignId,
    node.campaign_id,
    node.goodhitId,
    node.goodhit_id
  ];
  for (const candidate of candidates) {
    const text = String(candidate ?? '').trim();
    if (/^\d{4,}$/.test(text)) return text;
  }
  return null;
}

function extractCurrentBid(teaser) {
  if (!teaser || typeof teaser !== 'object') return null;
  for (const key of ['cpc','bid','price','bidPrice','goodPrice']) {
    const v = teaser?.[key];
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const locs = teaser?.priceOfClickByLocations;
  if (Array.isArray(locs) && locs.length === 1) {
    const n = parseFloat(locs[0]?.priceOfClick);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sleepJitter(baseMs = 400, jitterMs = 150) {
  const ms = Math.max(0, baseMs + (Math.random()*2-1) * jitterMs);
  return new Promise(r => setTimeout(r, ms));
}














