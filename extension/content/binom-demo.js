/*
 * Binom Magic hover metrics (content script)
 * Stores Adskeeper metrics locally and presents them via hover overlay.
 */

(function () {
  const DEBUG_PREFIX = '[BinomMagicCS]';
  const ENABLE_COLUMN_INJECTION = false;
  const DEFAULT_TOKENS = Object.freeze({
    widgetId: 'token_1',
    teaserId: 'token_2',
    sourceCampaignId: 'token_3'
  });
  const SUPPORTED_GROUPINGS = new Set(['campaign', 'token_1', 'token_2', 'token_3']);

  const AK_CACHE = {
    metrics: {
      teaser: new Map(),
      widget: new Map(),
      campaign: new Map()
    },
    status: new Map(),
    meta: {
      campaignId: null,
      sourceCampaignId: null,
      trackerCampaignId: null,
      trackerCampaignIdsKey: null,
      trafficSourceId: null,
      timeZone: null,
      dateType: null,
      startDate: null,
      endDate: null,
      version: 0
    }
  };

  const pendingRequests = new Map();

  let overlayElement = null;
  let overlayTitleElement = null;
  let overlaySubtitleElement = null;
  let overlayMetricsElement = null;
  let overlayStatusElement = null;
  let overlayActionsElement = null;
  let overlayPinnedIndicator = null;
  let overlayActionState = {
    key: '',
    updateCost: { state: 'idle', label: '' },
    toggleStatus: { state: 'idle', label: '' }
  };

  let ctrlPressed = false;
  let overlayPinned = false;
  let lastCtrlTimestamp = 0;
  let pointerPosition = { x: 0, y: 0 };
  let hoveredInfo = null;
  let activeInfo = null;
  let activeEntry = null;
  let hoverControllerReady = false;
  let currentReportContext = null;

  function log(...args) { try { console.log(DEBUG_PREFIX, ...args); } catch (_) {} }
  function warn(...args) { try { console.warn(DEBUG_PREFIX, ...args); } catch (_) {} }

  function getTokenFieldMap() {
    return { ...DEFAULT_TOKENS };
  }

  function readGroupingValues(searchParams) {
    const values = [];
    for (const [key, value] of searchParams.entries()) {
      if (key === 'groupings[]' || /^groupings\[\d+\]$/.test(key)) {
        const normalized = String(value || '').trim();
        if (normalized) values.push(normalized);
      }
    }
    return values;
  }

  function normalizeGroupingLabel(label) {
    const text = String(label || '').trim().toLowerCase();
    if (!text || text === 'choose grouping') return '';
    if (/^t1\b/.test(text)) return 'token_1';
    if (/^t2\b/.test(text)) return 'token_2';
    if (/^t3\b/.test(text)) return 'token_3';
    if (/^campaign\b/.test(text)) return 'campaign';
    return '';
  }

  function readGroupingValuesFromDom() {
    try {
      // TODO(ru/en): Эти селекторы завязаны на внутренние class names Binom и хрупки к UI-изменениям.
      // По возможности перейти на более стабильные data-атрибуты или структурные якоря.
      // These selectors depend on internal Binom class names and are fragile against UI changes.
      // Prefer more stable data attributes or structural anchors where possible.
      const nodes = document.querySelectorAll('[data-role="popup-trigger"] ._content_w6rk5_17, [data-role="popup-trigger"] [title]');
      const values = [];
      for (const node of nodes) {
        const raw = node?.getAttribute?.('title') || node?.textContent || '';
        const normalized = normalizeGroupingLabel(raw);
        if (normalized) values.push(normalized);
      }
      return Array.from(new Set(values));
    } catch (_) {
      return [];
    }
  }

  function deriveReportContextFromUrl(inputUrl = window.location.href) {
    const url = inputUrl instanceof URL ? inputUrl : new URL(String(inputUrl || window.location.href));
    const parts = url.pathname.split('/').filter(Boolean);
    const reportIndex = parts.indexOf('report');
    const isReportPage = reportIndex >= 0;
    const reportType = isReportPage ? (parts[reportIndex + 1] || '') : '';
    const reportIds = isReportPage ? parts.slice(reportIndex + 2).filter((part) => /^\d+$/.test(part)) : [];
    const tokenMap = getTokenFieldMap();
    const urlGroupings = readGroupingValues(url.searchParams);
    const domGroupings = readGroupingValuesFromDom();
    const groupings = Array.from(new Set([...(urlGroupings || []), ...(domGroupings || [])]));
    const supportedValues = new Set(['campaign', tokenMap.widgetId, tokenMap.teaserId, tokenMap.sourceCampaignId]);
    const supported = isReportPage && groupings.some((value) => supportedValues.has(value));
    const trackerCampaignIds = reportType === 'campaign' ? reportIds.slice() : [];
    const trafficSourceId = reportType === 'traffic-source' ? (reportIds[0] || null) : null;
    return {
      isReportPage,
      supported,
      reportType,
      reportIds,
      trackerCampaignIds,
      trafficSourceId,
      groupings,
      urlGroupings,
      domGroupings,
      tokenMap
    };
  }

  function getReportContext() {
    try {
      currentReportContext = deriveReportContextFromUrl();
      return currentReportContext;
    } catch (error) {
      warn('Failed to derive report context', error);
      currentReportContext = {
        isReportPage: false,
        supported: false,
        reportType: '',
        reportIds: [],
        trackerCampaignIds: [],
        trafficSourceId: null,
        groupings: [],
        tokenMap: getTokenFieldMap()
      };
      return currentReportContext;
    }
  }

  function isSupportedReportContext(context = currentReportContext || getReportContext()) {
    return !!context?.supported;
  }

  function getPrimaryGrouping(reportContext = currentReportContext || getReportContext()) {
    const groupings = Array.isArray(reportContext?.groupings) ? reportContext.groupings : [];
    return groupings.find((value) => SUPPORTED_GROUPINGS.has(String(value))) || '';
  }

  function hasUniquePageCampaignScope(reportContext = currentReportContext || getReportContext()) {
    return reportContext?.reportType === 'campaign' && Array.isArray(reportContext?.trackerCampaignIds) && reportContext.trackerCampaignIds.length === 1;
  }

  function extractTrackerCampaignRowId(row) {
    if (!row) return null;
    const directId = extractNumericId(extractCellText(row, ['div[data-column="id"]']), 1);
    if (directId) return directId;
    const text = row.innerText || row.textContent || '';
    const markerMatch = text.match(/\(id:\s*(\d+)\)/i);
    return markerMatch ? markerMatch[1] : null;
  }

  function getRowGrouping(row, reportContext = currentReportContext || getReportContext()) {
    if (!row) return '';
    if (extractTokenValue(row, 3)) return reportContext?.tokenMap?.sourceCampaignId || 'token_3';
    if (extractTokenValue(row, 2)) return reportContext?.tokenMap?.teaserId || 'token_2';
    if (extractTokenValue(row, 1)) return reportContext?.tokenMap?.widgetId || 'token_1';
    if (extractTrackerCampaignRowId(row)) return 'campaign';
    const primaryGrouping = getPrimaryGrouping(reportContext);
    return primaryGrouping || '';
  }

  function isEntityAllowedByGroupingDepth(reportContext, entityGrouping) {
    const grouping = String(entityGrouping || '').trim();
    const groupings = Array.isArray(reportContext?.groupings) ? reportContext.groupings.map((value) => String(value || '').trim()).filter(Boolean) : [];
    if (!grouping || !groupings.length) return true;
    if (grouping === 'campaign' || grouping === (reportContext?.tokenMap?.sourceCampaignId || 'token_3')) return true;
    const index = groupings.indexOf(grouping);
    if (index <= 0) return true;
    const previous = groupings.slice(0, index);
    return !previous.some((value) => value === (reportContext?.tokenMap?.widgetId || 'token_1') || value === (reportContext?.tokenMap?.teaserId || 'token_2'));
  }

  function cacheBucket(entity) {
    if (entity === 'widget') return AK_CACHE.metrics.widget;
    if (entity === 'campaign') return AK_CACHE.metrics.campaign;
    return AK_CACHE.metrics.teaser;
  }

  function entityKey(entity, id) {
    return `${entity}:${String(id)}`;
  }

  function serializeTrackerCampaignIds(ids) {
    if (Array.isArray(ids)) {
      return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))).sort().join(',');
    }
    return String(ids || '').trim();
  }

  function normalizeScopeMeta(meta = {}) {
    return {
      sourceCampaignId: String(meta.sourceCampaignId || meta.campaignId || '').trim(),
      trackerCampaignIdsKey: serializeTrackerCampaignIds(meta.trackerCampaignIdsKey || meta.trackerCampaignIds || ''),
      startDate: String(meta.startDate || '').trim(),
      endDate: String(meta.endDate || '').trim(),
      dateType: String(meta.dateType || '').trim(),
      timeZone: String(meta.timeZone || '').trim()
    };
  }

  function metricScopeKey(meta = {}) {
    const scope = normalizeScopeMeta(meta);
    return [
      scope.sourceCampaignId || '-',
      scope.trackerCampaignIdsKey || '-',
      scope.startDate || '-',
      scope.endDate || '-',
      scope.dateType || '-',
      scope.timeZone || '-'
    ].join('|');
  }

  function cacheKey(entity, id, meta = {}) {
    return `${entityKey(entity, id)}:${metricScopeKey(meta)}`;
  }

  function sanitizeMetaForRemember(patch = {}, reportContext = currentReportContext || getReportContext()) {
    const next = { ...patch };
    if (!hasUniquePageCampaignScope(reportContext)) {
      delete next.campaignId;
      delete next.sourceCampaignId;
      delete next.trackerCampaignId;
    }
    return next;
  }

  function rememberMeta(patch = {}) {
    let changed = false;
    if (patch.campaignId && patch.campaignId !== AK_CACHE.meta.campaignId) {
      AK_CACHE.meta.campaignId = patch.campaignId;
      changed = true;
    }
    if (patch.sourceCampaignId && patch.sourceCampaignId !== AK_CACHE.meta.sourceCampaignId) {
      AK_CACHE.meta.sourceCampaignId = patch.sourceCampaignId;
      changed = true;
    }
    if (patch.trackerCampaignId && patch.trackerCampaignId !== AK_CACHE.meta.trackerCampaignId) {
      AK_CACHE.meta.trackerCampaignId = patch.trackerCampaignId;
      changed = true;
    }
    if (patch.trackerCampaignIdsKey && patch.trackerCampaignIdsKey !== AK_CACHE.meta.trackerCampaignIdsKey) {
      AK_CACHE.meta.trackerCampaignIdsKey = patch.trackerCampaignIdsKey;
      changed = true;
    }
    if (patch.trafficSourceId && patch.trafficSourceId !== AK_CACHE.meta.trafficSourceId) {
      AK_CACHE.meta.trafficSourceId = patch.trafficSourceId;
      changed = true;
    }
    if (patch.timeZone && patch.timeZone !== AK_CACHE.meta.timeZone) {
      AK_CACHE.meta.timeZone = patch.timeZone;
      changed = true;
    }
    if (patch.dateType && patch.dateType !== AK_CACHE.meta.dateType) {
      AK_CACHE.meta.dateType = patch.dateType;
      changed = true;
    }
    if (patch.startDate && patch.startDate !== AK_CACHE.meta.startDate) {
      AK_CACHE.meta.startDate = patch.startDate;
      changed = true;
    }
    if (patch.endDate && patch.endDate !== AK_CACHE.meta.endDate) {
      AK_CACHE.meta.endDate = patch.endDate;
      changed = true;
    }
    if (changed) {
      AK_CACHE.meta.version = (AK_CACHE.meta.version || 0) + 1;
    }
  }

  function setMetric(entity, id, payload, options = {}) {
    if (options.meta) rememberMeta(sanitizeMetaForRemember(options.meta));
    const rangePatch = options.range || null;
    if (rangePatch && (rangePatch.startDate || rangePatch.endDate)) {
      rememberMeta({ startDate: rangePatch.startDate, endDate: rangePatch.endDate });
    }
    const bucket = cacheBucket(entity);
    if (!bucket) return;
    const scopeMeta = { ...AK_CACHE.meta, ...(options.meta || {}), ...(options.range || {}) };
    const key = cacheKey(entity, id, scopeMeta);
    const previous = bucket.get(key);
    const entry = {
      id: String(id),
      entity: entity === 'widget' ? 'widget' : (entity === 'campaign' ? 'campaign' : 'teaser'),
      metrics: payload ? { ...payload } : null,
      receivedAt: Date.now(),
      range: options.range || previous?.range || null,
      meta: options.meta || previous?.meta || null,
      scopeKey: metricScopeKey(scopeMeta)
    };
    bucket.set(key, entry);
    AK_CACHE.status.delete(cacheKey(entity, id, scopeMeta));
    if (activeInfo && activeInfo.entity === entry.entity && activeInfo.id === String(id)) {
      activeEntry = entry;
      renderOverlayContent(entry);
    }
  }

  function getMetric(entity, id, meta = AK_CACHE.meta) {
    const bucket = cacheBucket(entity);
    if (!bucket) return null;
    return bucket.get(cacheKey(entity, id, meta)) || null;
  }

  function setStatus(entity, id, status, meta = AK_CACHE.meta) {
    const key = cacheKey(entity, id, meta);
    const value = typeof status === 'string' ? { state: status } : { ...status };
    value.updatedAt = Date.now();
    AK_CACHE.status.set(key, value);
    if (activeInfo && cacheKey(activeInfo.entity, activeInfo.id, meta) === key) {
      renderOverlayContent(getMetric(entity, id, meta));
    }
  }

  function getStatus(entity, id, meta = AK_CACHE.meta) {
    return AK_CACHE.status.get(cacheKey(entity, id, meta)) || null;
  }

  function clearStatus(entity, id, meta = AK_CACHE.meta) {
    AK_CACHE.status.delete(cacheKey(entity, id, meta));
  }

  function patchEntryMetrics(entry, patch = {}) {
    if (!entry?.metrics) return entry;
    return {
      ...entry,
      metrics: {
        ...entry.metrics,
        ...patch
      }
    };
  }

  function replaceActiveEntry(info, entry) {
    if (!info || !entry?.metrics) return;
    setMetric(info.entity, info.id, entry.metrics, {
      range: entry.range || null,
      meta: entry.meta || null
    });
  }

  function buildScopeMetaForInfo(info, pageMeta = getCampaignMetaFromPage()) {
    const reportContext = pageMeta.reportContext || currentReportContext || getReportContext();
    const sourceGrouping = reportContext?.tokenMap?.sourceCampaignId || 'token_3';
    const scopeMeta = {
      ...AK_CACHE.meta,
      campaignId: pageMeta.campaignId || AK_CACHE.meta.campaignId || null,
      sourceCampaignId: pageMeta.sourceCampaignId || AK_CACHE.meta.sourceCampaignId || pageMeta.campaignId || null,
      trackerCampaignId: pageMeta.trackerCampaignId || AK_CACHE.meta.trackerCampaignId || null,
      trackerCampaignIdsKey: info?.trackerCampaignIdsKey || pageMeta.trackerCampaignIdsKey || AK_CACHE.meta.trackerCampaignIdsKey || null,
      startDate: pageMeta.startDate || AK_CACHE.meta.startDate || null,
      endDate: pageMeta.endDate || AK_CACHE.meta.endDate || null,
      timeZone: pageMeta.timeZone || AK_CACHE.meta.timeZone || null,
      dateType: pageMeta.dateType || AK_CACHE.meta.dateType || null
    };

    if (info?.entity === 'campaign') {
      if (info.campaignScopeKind === 'source' || info.entityGrouping === sourceGrouping) {
        scopeMeta.campaignId = info.sourceCampaignId || null;
        scopeMeta.sourceCampaignId = info.sourceCampaignId || null;
        if (!hasUniquePageCampaignScope(reportContext)) {
          scopeMeta.trackerCampaignId = null;
        }
      } else if (info.campaignScopeKind === 'tracker' || info.entityGrouping === 'campaign') {
        scopeMeta.campaignId = null;
        scopeMeta.sourceCampaignId = null;
        scopeMeta.trackerCampaignId = info.trackerCampaignId || scopeMeta.trackerCampaignId || null;
      }
    }

    return scopeMeta;
  }

  function clearInMemoryEntityCache(reason = 'manual') {
    AK_CACHE.metrics.teaser.clear();
    AK_CACHE.metrics.widget.clear();
    AK_CACHE.metrics.campaign.clear();
    AK_CACHE.status.clear();
    pendingRequests.clear();
    AK_CACHE.meta.campaignId = null;
    AK_CACHE.meta.sourceCampaignId = null;
    AK_CACHE.meta.trackerCampaignId = null;
    AK_CACHE.meta.trackerCampaignIdsKey = null;
    AK_CACHE.meta.trafficSourceId = null;
    AK_CACHE.meta.timeZone = null;
    AK_CACHE.meta.dateType = null;
    AK_CACHE.meta.startDate = null;
    AK_CACHE.meta.endDate = null;
    AK_CACHE.meta.version = (AK_CACHE.meta.version || 0) + 1;
    hoveredInfo = null;
    activeInfo = null;
    overlayPinned = false;
    ctrlPressed = false;
    hideOverlay();
    log('Cleared in-memory entity cache', { reason, path: window.location.pathname, search: window.location.search });
  }

  window.BinomMagicCache = {
    getMetric,
    setMetric,
    setStatus,
    getStatus,
    clearInMemoryEntityCache,
    rememberMeta,
    state: AK_CACHE
  };

  function ensureOverlay() {
    if (overlayElement) return;
    const style = document.createElement('style');
    style.textContent = `
      .bm-ak-overlay {
        position: fixed;
        min-width: 240px;
        max-width: 320px;
        padding: 16px 18px 18px;
        background: rgba(18, 18, 24, 0.94);
        color: #f5f5f7;
        border-radius: 12px;
        box-shadow: 0 18px 40px rgba(0,0,0,0.45);
        font-family: "Inter", "Segoe UI", sans-serif;
        z-index: 2147483647;
        pointer-events: none;
        opacity: 0;
        transform: translate(-50%, -12px) scale(0.98);
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .bm-ak-overlay.is-visible {
        opacity: 1;
        transform: translate(-50%, -12px) scale(1);
      }
      .bm-ak-overlay.is-pinned {
        pointer-events: auto;
        border: 1px solid rgba(96,115,255,0.45);
      }
      .bm-ak-overlay__title {
        margin: 0 0 4px;
        font-size: 16px;
        font-weight: 600;
        letter-spacing: 0.015em;
      }
      .bm-ak-overlay__subtitle {
        margin: 0 0 12px;
        font-size: 12px;
        color: #c2c3d0;
        letter-spacing: 0.02em;
      }
      .bm-ak-overlay__metrics {
        display: grid;
        grid-template-columns: auto auto;
        gap: 6px 16px;
        font-size: 13px;
      }
      .bm-ak-overlay__metric-label {
        color: #a0a3b2;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
      }
      .bm-ak-overlay__metric-value {
        font-weight: 500;
      }
      .bm-ak-overlay__status {
        margin-top: 12px;
        font-size: 12px;
        color: #f9d67a;
        display: none;
      }
      .bm-ak-overlay__status.is-visible {
        display: block;
      }
      .bm-ak-overlay__actions {
        display: none;
        margin-top: 14px;
        gap: 8px;
        flex-wrap: wrap;
      }
      .bm-ak-overlay__actions.is-visible {
        display: flex;
      }
      .bm-ak-overlay__button {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        color: #f5f5f7;
        border-radius: 8px;
        padding: 7px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .bm-ak-overlay__button:hover {
        background: rgba(255,255,255,0.1);
      }
      .bm-ak-overlay__button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .bm-ak-overlay__button[data-variant="danger"] {
        border-color: rgba(255, 107, 107, 0.35);
      }
      .bm-ak-overlay__pinned {
        position: absolute;
        top: 10px;
        right: 14px;
        font-size: 10px;
        letter-spacing: 0.12em;
        color: #a6b2ff;
        opacity: 0;
        transition: opacity 120ms ease;
      }
      .bm-ak-overlay.is-pinned .bm-ak-overlay__pinned {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);

    overlayElement = document.createElement('div');
    overlayElement.className = 'bm-ak-overlay';
    overlayElement.setAttribute('role', 'tooltip');

    const title = document.createElement('h3');
    title.className = 'bm-ak-overlay__title';
    overlayElement.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'bm-ak-overlay__subtitle';
    overlayElement.appendChild(subtitle);

    const metrics = document.createElement('div');
    metrics.className = 'bm-ak-overlay__metrics';
    overlayElement.appendChild(metrics);

    const status = document.createElement('div');
    status.className = 'bm-ak-overlay__status';
    overlayElement.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'bm-ak-overlay__actions';
    overlayElement.appendChild(actions);

    const pinned = document.createElement('div');
    pinned.className = 'bm-ak-overlay__pinned';
    pinned.textContent = 'PINNED';
    overlayElement.appendChild(pinned);

    overlayTitleElement = title;
    overlaySubtitleElement = subtitle;
    overlayMetricsElement = metrics;
    overlayStatusElement = status;
    overlayActionsElement = actions;
    overlayPinnedIndicator = pinned;

    overlayElement.addEventListener('mouseleave', handlePointerLeave);

    document.body.appendChild(overlayElement);
  }

  function hideOverlay() {
    activeInfo = null;
    activeEntry = null;
    resetOverlayActionState(null);
    if (!overlayElement) return;
    if (overlayElement.classList.contains('is-visible')) {
      log('Hide overlay');
    }
    overlayElement.classList.remove('is-visible', 'is-pinned');
    if (overlayPinnedIndicator) overlayPinnedIndicator.style.display = 'none';
  }

  function formatNumber(value) {
    if (value === null || value === undefined) return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (Math.abs(n) >= 1000) {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
    }
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
  }

  function formatCurrency(value) {
    if (value === null || value === undefined) return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
  }

  function formatRange(range) {
    if (!range) return 'Period: unknown';
    const { startDate, endDate } = range;
    if (startDate && endDate) return `Period: ${startDate} → ${endDate}`;
    if (startDate) return `Since ${startDate}`;
    if (endDate) return `Until ${endDate}`;
    return 'Period: unknown';
  }

  function formatCampaignScope(meta) {
    if (!meta || typeof meta !== 'object') return '';
    const sourceIds = Array.isArray(meta.sourceCampaignIdsUsed) ? meta.sourceCampaignIdsUsed.filter(Boolean) : [];
    const trackerIds = Array.isArray(meta.trackerCampaignIdsUsed) ? meta.trackerCampaignIdsUsed.filter(Boolean) : [];
    if (sourceIds.length) {
      return `AK campaigns: ${sourceIds.join(', ')}`;
    }
    if (trackerIds.length) {
      return `Tracker campaigns: ${trackerIds.join(', ')}`;
    }
    return '';
  }

  function getOverlayActionKey(info = activeInfo) {
    if (!info) return '';
    return `${info.entity}:${String(info.id || '')}`;
  }

  function resetOverlayActionState(info = activeInfo) {
    overlayActionState = {
      key: getOverlayActionKey(info),
      updateCost: { state: 'idle', label: '' },
      toggleStatus: { state: 'idle', label: '' }
    };
  }

  function ensureOverlayActionState(info = activeInfo) {
    const key = getOverlayActionKey(info);
    if (overlayActionState.key !== key) {
      resetOverlayActionState(info);
    }
    return overlayActionState;
  }

  function isActionPending() {
    return overlayActionState.updateCost.state === 'loading' || overlayActionState.toggleStatus.state === 'loading';
  }

  function formatActionButtonLabel(baseLabel, state) {
    const safeBase = state?.label || baseLabel;
    if (state?.state === 'loading') return `${safeBase} ⏳`;
    if (state?.state === 'success') return `${safeBase} ✅`;
    if (state?.state === 'error') return `${safeBase} ❌`;
    return safeBase;
  }

  function setOverlayActionState(actionKey, next = {}) {
    ensureOverlayActionState(activeInfo);
    if (!overlayActionState[actionKey]) return;
    overlayActionState[actionKey] = {
      ...overlayActionState[actionKey],
      ...next
    };
    if (activeInfo) {
      const pageMeta = getCampaignMetaFromPage();
      const entry = (activeEntry && activeEntry.entity === activeInfo.entity && String(activeEntry.id) === String(activeInfo.id))
        ? activeEntry
        : getMetric(activeInfo.entity, activeInfo.id, buildScopeMetaForInfo(activeInfo, pageMeta));
      renderOverlayContent(entry);
    }
  }

  function showActionError(actionKey, label, statusCode, errorMessage) {
    setOverlayActionState(actionKey, { state: 'error', label });
    const statusLine = statusCode != null && statusCode !== '' ? String(statusCode) : 'unknown';
    const messageLine = errorMessage || 'Unknown error';
    alert(`${label} failed\nStatus: ${statusLine}\nError: ${messageLine}`);
  }

  function createActionTraceId(actionName, info = activeInfo) {
    const entity = String(info?.entity || 'unknown');
    const id = String(info?.id || 'unknown');
    return `${actionName}:${entity}:${id}:${Date.now()}`;
  }

  function getOverlayActionButton(target) {
    const button = target?.closest?.('[data-bm-action]');
    if (!button) return null;
    if (!button.closest?.('.bm-ak-overlay')) return null;
    return button;
  }

  function isEffectivelyActiveStatus(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const normalized = raw.toLowerCase();
    if (normalized.includes('block') || normalized.includes('pause') || normalized.includes('reject') || normalized.includes('stop')) return false;
    if (normalized === 'active' || normalized === 'new' || normalized === 'goodperformance' || normalized === 'good_performance' || normalized === 'included') return true;
    return true;
  }

  function buildEntityRequestPayload(entity, id, rowInfo, pageMeta = getCampaignMetaFromPage()) {
    const reportContext = pageMeta.reportContext || currentReportContext || getReportContext();
    const meta = buildScopeMetaForInfo(rowInfo || { entity, id }, pageMeta);
    const sourceGrouping = reportContext?.tokenMap?.sourceCampaignId || 'token_3';
    let payloadSourceCampaignId = meta.sourceCampaignId || meta.campaignId || '';
    let payloadTrackerCampaignId = rowInfo?.trackerCampaignId || meta.trackerCampaignId || '';
    if (entity === 'campaign') {
      if (rowInfo?.campaignScopeKind === 'source' || rowInfo?.entityGrouping === sourceGrouping) {
        payloadSourceCampaignId = rowInfo?.sourceCampaignId || payloadSourceCampaignId || '';
        if (!hasUniquePageCampaignScope(reportContext)) {
          payloadTrackerCampaignId = '';
        }
      } else if (rowInfo?.campaignScopeKind === 'tracker' || rowInfo?.entityGrouping === 'campaign') {
        payloadSourceCampaignId = '';
        payloadTrackerCampaignId = rowInfo?.trackerCampaignId || payloadTrackerCampaignId || '';
      }
    }
    return {
      meta,
      reportContext,
      payload: {
        entity,
        id,
        campaignId: payloadSourceCampaignId,
        sourceCampaignId: payloadSourceCampaignId,
        trackerCampaignId: payloadTrackerCampaignId,
        trackerCampaignIds: Array.isArray(rowInfo?.trackerCampaignIds) ? rowInfo.trackerCampaignIds : [],
        trafficSourceId: rowInfo?.trafficSourceId || meta.trafficSourceId || '',
        entityGrouping: rowInfo?.entityGrouping || '',
        campaignScopeKind: rowInfo?.campaignScopeKind || '',
        startDate: meta.startDate,
        endDate: meta.endDate,
        timeZone: AK_CACHE.meta.timeZone || pageMeta.timeZone || 'Europe/Moscow',
        dateType: AK_CACHE.meta.dateType || pageMeta.dateType || ''
      }
    };
  }

  function renderOverlayContent(entry) {
    ensureOverlay();
    const info = activeInfo;
    if (!info) {
      hideOverlay();
      return;
    }
    const resolvedEntry = (entry && entry.metrics)
      ? entry
      : ((activeEntry && activeEntry.entity === info.entity && String(activeEntry.id) === String(info.id) && activeEntry.metrics)
          ? activeEntry
          : null);

    const baseSubtitle = info.subtitle ? info.subtitle + ' • ' : '';
    overlayTitleElement.textContent = info.title;
    overlaySubtitleElement.textContent = baseSubtitle || '';
    overlayPinnedIndicator.style.display = overlayPinned ? 'block' : 'none';

    const pageMeta = getCampaignMetaFromPage();
    const scopeMeta = buildScopeMetaForInfo(info, pageMeta);
    const status = getStatus(info.entity, info.id, scopeMeta);
    activeEntry = resolvedEntry || activeEntry;
    ensureOverlayActionState(info);
    const shouldShowStatus = !!(status && status.state && !(resolvedEntry?.metrics && status.state === 'loading'));
    if (shouldShowStatus) {
      overlayStatusElement.textContent = status.message || status.state;
      overlayStatusElement.classList.add('is-visible');
    } else {
      overlayStatusElement.textContent = '';
      overlayStatusElement.classList.remove('is-visible');
    }

    if (!resolvedEntry || !resolvedEntry.metrics) {
      const emptyStateMessage = status?.state === 'skipped'
        ? (status.message || 'Source stats unavailable for this grouping depth')
        : 'Loading...';
      // TODO(ru/en): Не рендерить значения из API/страницы через innerHTML.
      // Здесь безопаснее собрать DOM через createElement/textContent, чтобы убрать XSS-риск.
      // Do not render API/page-derived values via innerHTML.
      // Building this DOM with createElement/textContent would remove the XSS risk.
      overlayMetricsElement.innerHTML = `
        <div class="bm-ak-overlay__metric-label">Status</div>
        <div class="bm-ak-overlay__metric-value">${emptyStateMessage}</div>
        <div class="bm-ak-overlay__metric-label">Source</div>
        <div class="bm-ak-overlay__metric-value">Adskeeper</div>
      `;
      overlayActionsElement.innerHTML = '';
      overlayActionsElement.classList.remove('is-visible');
      return;
    }

    const scopeLine = formatCampaignScope(resolvedEntry.meta);
    overlaySubtitleElement.textContent = scopeLine
      ? `${formatRange(resolvedEntry.range || AK_CACHE.meta)} • ${scopeLine}`
      : formatRange(resolvedEntry.range || AK_CACHE.meta);

    const m = resolvedEntry.metrics;
    const statusLabel = info.entity === 'teaser' ? 'Teaser' : 'Status';
    const teaserCampaignStatusRow = info.entity === 'teaser'
      ? `
      <div class="bm-ak-overlay__metric-label">Campaign</div>
      <div class="bm-ak-overlay__metric-value">${m.campaignStatus || '—'}</div>
      `
      : '';
    // TODO(ru/en): Здесь тот же XSS-риск для status/campaignStatus из внешних ответов.
    // Не пускать такие значения в DOM как HTML.
    // Same XSS risk here for external status/campaignStatus values.
    // Do not let them reach the DOM as HTML.
    overlayMetricsElement.innerHTML = `
      <div class="bm-ak-overlay__metric-label">Impressions</div>
      <div class="bm-ak-overlay__metric-value">${formatNumber(m.impressions)}</div>
      <div class="bm-ak-overlay__metric-label">Clicks</div>
      <div class="bm-ak-overlay__metric-value">${formatNumber(m.clicks)}</div>
      <div class="bm-ak-overlay__metric-label">Spend</div>
      <div class="bm-ak-overlay__metric-value">${formatCurrency(m.spend)}</div>
      <div class="bm-ak-overlay__metric-label">CPC</div>
      <div class="bm-ak-overlay__metric-value">${formatCurrency(m.cpc)}</div>
      <div class="bm-ak-overlay__metric-label">Bid</div>
      <div class="bm-ak-overlay__metric-value">${m.bid != null ? formatCurrency(m.bid) : '—'}</div>
      <div class="bm-ak-overlay__metric-label">${statusLabel}</div>
      <div class="bm-ak-overlay__metric-value">${m.status || '—'}</div>
      ${teaserCampaignStatusRow}
    `;

    const supportsActions = overlayPinned && (info.entity === 'campaign' || info.entity === 'teaser' || info.entity === 'widget');
    if (!supportsActions) {
      overlayActionsElement.innerHTML = '';
      overlayActionsElement.classList.remove('is-visible');
      return;
    }

    const anyPending = isActionPending();
    const supportsToggleStatus = info.entity === 'campaign' || info.entity === 'teaser';
    const entityActive = isEffectivelyActiveStatus(m.status);
    const toggleBaseLabel = entityActive === false ? 'Start' : 'Pause';
    const updateCostState = overlayActionState.updateCost;
    const toggleStatusState = overlayActionState.toggleStatus;
    const toggleVariant = toggleBaseLabel === 'Pause' ? 'danger' : 'default';
    const toggleStatusButton = supportsToggleStatus ? `
      <button
        type="button"
        class="bm-ak-overlay__button"
        data-bm-action="update-cost"
        ${anyPending ? 'disabled' : ''}
      >${formatActionButtonLabel('Update cost', updateCostState)}</button>
      <button
        type="button"
        class="bm-ak-overlay__button"
        data-bm-action="toggle-status"
        data-variant="${toggleVariant}"
        ${anyPending ? 'disabled' : ''}
      >${formatActionButtonLabel(toggleBaseLabel, toggleStatusState)}</button>
    ` : `
      <button
        type="button"
        class="bm-ak-overlay__button"
        data-bm-action="update-cost"
        ${anyPending ? 'disabled' : ''}
      >${formatActionButtonLabel('Update cost', updateCostState)}</button>
    `;
    overlayActionsElement.innerHTML = toggleStatusButton;
    overlayActionsElement.classList.add('is-visible');
  }

  async function executeOverlayAction(actionName, actionTraceId = createActionTraceId(actionName)) {
    if (!activeInfo) return;
    const pageMeta = getCampaignMetaFromPage();
    const info = activeInfo;
    const scopeMeta = buildScopeMetaForInfo(info, pageMeta);
    const entry = (activeEntry && activeEntry.entity === info.entity && String(activeEntry.id) === String(info.id))
      ? activeEntry
      : getMetric(info.entity, info.id, scopeMeta);
    if (!entry?.metrics) {
      warn('Overlay action aborted - metric entry missing', {
        actionName,
        actionTraceId,
        entity: info.entity,
        id: info.id,
        scopeMeta,
        cacheKey: cacheKey(info.entity, info.id, scopeMeta),
        hasActiveInfo: !!activeInfo
      });
      showActionError(
        actionName === 'update-cost' ? 'updateCost' : 'toggleStatus',
        actionName === 'update-cost' ? 'Update cost' : 'Action',
        'local',
        'Metric entry not found in current overlay scope'
      );
      return;
    }

    if (actionName === 'update-cost') {
      const spend = Number(entry.metrics.spend);
      if (!Number.isFinite(spend)) {
        showActionError('updateCost', 'Update cost', 'local', 'Current AdsKeeper spend is unavailable for this entity');
        return;
      }
      setOverlayActionState('updateCost', { state: 'loading', label: 'Update cost' });
      const { payload } = buildEntityRequestPayload(info.entity, info.id, info, pageMeta);
      log('Overlay action send', { action: 'update-cost', actionTraceId, entity: info.entity, id: info.id, payload });
      chrome.runtime.sendMessage({
        type: 'AK_ACTION_UPDATE_COST',
        ...payload,
        spend,
        actionTraceId
      }, async (response) => {
        log('Overlay action response', { action: 'update-cost', actionTraceId, entity: info.entity, id: info.id, response, lastError: chrome.runtime.lastError?.message || null });
        if (chrome.runtime.lastError) {
          showActionError('updateCost', 'Update cost', 'runtime', chrome.runtime.lastError.message || 'Unknown runtime error');
          return;
        }
        if (!response?.ok) {
          showActionError('updateCost', 'Update cost', response?.statusCode ?? 'request', response?.error || 'Request failed');
          return;
        }
        setOverlayActionState('updateCost', { state: 'success', label: 'Update cost' });
        clearStatus(info.entity, info.id, entry.meta || scopeMeta);
      });
      return;
    }

    if (actionName === 'toggle-status') {
      const entityActive = isEffectivelyActiveStatus(entry.metrics.status);
      const baseLabel = entityActive === false ? 'Start' : 'Pause';
      const targetBlocked = entityActive === false ? 0 : 1;
      setOverlayActionState('toggleStatus', { state: 'loading', label: baseLabel });
      const { payload } = buildEntityRequestPayload(info.entity, info.id, info, pageMeta);
      const messageType = info.entity === 'campaign' ? 'AK_ACTION_SET_CAMPAIGN_STATUS' : 'AK_ACTION_SET_TEASER_STATUS';
      log('Overlay action send', { action: messageType, actionTraceId, entity: info.entity, id: info.id, payload, whetherToBlockByClient: targetBlocked });
      chrome.runtime.sendMessage({
        type: messageType,
        ...payload,
        whetherToBlockByClient: targetBlocked,
        actionTraceId
      }, async (response) => {
        log('Overlay action response', { action: messageType, actionTraceId, entity: info.entity, id: info.id, response, lastError: chrome.runtime.lastError?.message || null });
        if (chrome.runtime.lastError) {
          showActionError('toggleStatus', baseLabel, 'runtime', chrome.runtime.lastError.message || 'Unknown runtime error');
          return;
        }
        if (!response?.ok) {
          showActionError('toggleStatus', baseLabel, response?.statusCode ?? 'request', response?.error || 'Request failed');
          return;
        }
        setOverlayActionState('toggleStatus', { state: 'success', label: baseLabel });
        const nextStatus = response?.newStatus || (targetBlocked === 1 ? 'blocked' : 'active');
        replaceActiveEntry(info, patchEntryMetrics(entry, { status: nextStatus }));
        clearStatus(info.entity, info.id, entry.meta || scopeMeta);
      });
    }
  }

  function handleOverlayActionClick(event) {
    const button = getOverlayActionButton(event.target);
    if (!button || !overlayPinned || !activeInfo) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (button.disabled || isActionPending()) return;
    const actionName = button.getAttribute('data-bm-action') || '';
    const actionTraceId = createActionTraceId(actionName);
    log('Overlay action click', {
      actionName,
      actionTraceId,
      entity: activeInfo.entity,
      id: activeInfo.id,
      overlayPinned,
      buttonText: button.textContent?.trim() || ''
    });
    executeOverlayAction(actionName, actionTraceId).catch((error) => {
      warn('Overlay action failed', error);
    });
  }

  function updateOverlayPosition() {
    if (!overlayElement || !activeInfo) return;
    overlayElement.style.left = `${pointerPosition.x}px`;
    overlayElement.style.top = `${pointerPosition.y}px`;
  }

  function isSameInfo(left, right) {
    return !!left && !!right && left.entity === right.entity && String(left.id) === String(right.id);
  }

  function showOverlay(info) {
    if (!isSupportedReportContext()) return;
    ensureOverlay();
    if (isSameInfo(activeInfo, info) && overlayElement?.classList.contains('is-visible')) {
      overlayPinnedIndicator.style.display = overlayPinned ? 'block' : 'none';
      overlayElement.classList.toggle('is-pinned', overlayPinned);
      updateOverlayPosition();
      return;
    }
    activeInfo = info;
    activeEntry = null;
    resetOverlayActionState(info);
    log('Show overlay', { entity: info.entity, id: info.id, pinned: overlayPinned });
    overlayPinnedIndicator.style.display = overlayPinned ? 'block' : 'none';
    overlayElement.classList.toggle('is-pinned', overlayPinned);
    overlayElement.classList.add('is-visible');
    updateOverlayPosition();

    const pageMeta = getCampaignMetaFromPage();
    const scopeMeta = buildScopeMetaForInfo(info, pageMeta);
    const entry = getMetric(info.entity, info.id, scopeMeta);
    renderOverlayContent(entry);
    if (!entry) {
      fetchMetric(info.entity, info.id);
    }
  }

  function hideOverlayIfAllowed() {
    if (overlayPinned || ctrlPressed) return;
    hideOverlay();
  }


  const MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12'
  };

  function buildDateFromParts(monthKey, day, fallbackYear = new Date().getFullYear()) {
    const month = MONTHS[String(monthKey || '').slice(0,3).toLowerCase()];
    if (!month) return null;
    const dayNum = Number(day);
    if (!Number.isFinite(dayNum)) return null;
    return `${fallbackYear}-${month}-${String(dayNum).padStart(2, '0')}`;
  }

  function parseDateRangeLabel(label) {
    const cleaned = String(label || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return { start: null, end: null };
    const rangeMatch = cleaned.match(/^([A-Za-z]{3,})\s+(\d{1,2})\s*-\s*([A-Za-z]{3,})?\s*(\d{1,2})$/);
    if (rangeMatch) {
      const [, startMonth, startDay, endMonthRaw, endDay] = rangeMatch;
      const year = new Date().getFullYear();
      const start = buildDateFromParts(startMonth, startDay, year);
      const endMonth = endMonthRaw ? endMonthRaw : startMonth;
      let endYear = year;
      const startMonthNum = MONTHS[String(startMonth).slice(0,3).toLowerCase()];
      const endMonthNum = MONTHS[String(endMonth).slice(0,3).toLowerCase()];
      if (startMonthNum && endMonthNum && Number(endMonthNum) < Number(startMonthNum)) {
        endYear += 1;
      }
      const end = buildDateFromParts(endMonth, endDay, endYear);
      return { start, end };
    }
    return { start: null, end: null };
  }

	// --- Moscow/UTC+3 date helpers (no external libs) ---
	const DEFAULT_TZ = 'Europe/Moscow'; // forced, per your environment

	function pad2(n) { return String(n).padStart(2, '0'); }
	function toIsoDateUTC3(dUtc) {
	  // Convert a UTC Date into its calendar date in UTC+3
	  const utc3 = new Date(dUtc.getTime() + 3 * 60 * 60 * 1000);
	  const y = utc3.getUTCFullYear();
	  const m = pad2(utc3.getUTCMonth() + 1);
	  const d = pad2(utc3.getUTCDate());
	  return `${y}-${m}-${d}`;
	}
	function startOfDayUtc(dUtc) {
	  const t = new Date(dUtc);
	  t.setUTCHours(0,0,0,0);
	  return t;
	}
	function addDays(dUtc, days) {
	  const t = new Date(dUtc);
	  t.setUTCDate(t.getUTCDate() + days);
	  return t;
	}
	function getIsoWeekdayUtc3(dUtc) {
	  // 1..7 (Mon..Sun) in UTC+3
	  const wd = new Date(dUtc.getTime() + 3*3600*1000).getUTCDay();
	  return wd === 0 ? 7 : wd;
	}
	function computePresetRangeUtc3(dateType) {
	  const key = String(dateType || '').toLowerCase().replace(/\s+/g, '-');
	  const now = new Date(Date.now());
	  const today = startOfDayUtc(now);
	  let start = today, end = today;
	  const wd = getIsoWeekdayUtc3(now); // 1..7

	  switch (key) {
		case 'today':
		  break;
		case 'yesterday':
		  start = addDays(today, -1); end = addDays(today, -1);
		  break;
		case 'last-two-days':
		  start = addDays(today, -1);
		  break;
		case 'last-three-days':
		  start = addDays(today, -2);
		  break;
		case 'last-seven-days':
		  start = addDays(today, -6);
		  break;
		case 'last-14-days':
		case 'last-fourteen-days':
		  start = addDays(today, -13);
		  break;
		case 'last-30-days':
		  start = addDays(today, -29);
		  break;
		case 'this-week': {
		  start = addDays(today, -(wd - 1)); // Monday
		  end   = addDays(start, 6);
		  break;
		}
		case 'last-week': {
		  const thisMon = addDays(today, -(wd - 1));
		  start = addDays(thisMon, -7);
		  end   = addDays(start, 6);
		  break;
		}
		case 'this-month': {
		  const dt = new Date(now);
		  dt.setUTCDate(1); dt.setUTCHours(0,0,0,0);
		  start = dt;
		  const e = new Date(dt); e.setUTCMonth(e.getUTCMonth()+1); e.setUTCDate(0);
		  end = e;
		  break;
		}
		case 'last-month': {
		  const dt = new Date(now);
		  dt.setUTCDate(1); dt.setUTCHours(0,0,0,0);
		  dt.setUTCMonth(dt.getUTCMonth()-1);
		  start = dt;
		  const e = new Date(dt); e.setUTCMonth(e.getUTCMonth()+1); e.setUTCDate(0);
		  end = e;
		  break;
		}
		case 'this-year': {
		  const dt = new Date(now);
		  dt.setUTCMonth(0,1); dt.setUTCHours(0,0,0,0);
		  start = dt;
		  const e = new Date(dt); e.setUTCFullYear(e.getUTCFullYear(), 11, 31);
		  end = e;
		  break;
		}
		case 'last-year': {
		  const dt = new Date(now);
		  dt.setUTCFullYear(dt.getUTCFullYear()-1, 0, 1); dt.setUTCHours(0,0,0,0);
		  start = dt;
		  const e = new Date(dt); e.setUTCFullYear(e.getUTCFullYear(), 11, 31);
		  end = e;
		  break;
		}
		default:
		  return null;
	  }
	  return { startDate: toIsoDateUTC3(start), endDate: toIsoDateUTC3(end) };
	}

	// --- Binom UI readers based on your HTML samples ---
	const LABEL_ALIAS = new Map([
	  ['last 7 days', 'last-seven-days'],
	  ['last seven days', 'last-seven-days'],
	  ['last 30 days', 'last-30-days'],
	  ['last thirty days', 'last-30-days'],
	  ['last 14 days', 'last-fourteen-days'],
	  ['last fourteen days', 'last-fourteen-days'],
	  ['this week', 'this-week'],
	  ['last week', 'last-week'],
	  ['this month', 'this-month'],
	  ['last month', 'last-month'],
	  ['this year', 'this-year'],
	  ['last year', 'last-year'],
	  ['yesterday', 'yesterday'],
	  ['today', 'today'],
	  ['custom date', 'custom-date'],
	]);

	function normalizePresetLabel(s) {
	  const k = String(s || '').trim().toLowerCase();
	  return LABEL_ALIAS.get(k) || k.replace(/\s+/g, '-');
	}

	function readDateControls() {
	  const trigger = document.querySelector('[data-testid="data-table-date-filter-popup-trigger"]');
	  if (!trigger) return null;
	  const labelEl = trigger.querySelector('._content_w6rk5_17');
	  const label = (labelEl?.textContent || '').trim();

	  let rangeText = '', tzText = '';
	  const rangeField = document.querySelector('._rangeTimeField_nll18_5');
	  if (rangeField) {
		const parts = rangeField.querySelectorAll('._content_w6rk5_17');
		rangeText = (parts[0]?.textContent || '').trim(); // e.g. "Sep 15 -  18"
		tzText    = (parts[1]?.textContent || '').trim(); // e.g. "+03:00"
	  }
	  return { label, rangeText, tzText };
	}

	// --- Campaign ID fallback (token_3 first, then breadcrumbs), bounded retry ---
	let _campaignRetryTimer = null;
	let _campaignAttempts = 0;
	function sniffCampaignIdFromToken() {
	  const el = document.querySelector('[data-token-number="3"][data-token-value], [data-token-number="3"]');
	  const txt = el?.getAttribute('data-token-value') || el?.textContent || '';
	  const m = txt && txt.match(/\b\d{7,}\b/);
	  return m ? m[0] : null;
	}
	function sniffCampaignIdFromBreadcrumbs() {
	  const nodes = document.querySelectorAll('div[class*="breadcrumb" i] *, ul[class*="breadcrumb" i] *, div[class*="menu" i] span[class*="title" i]');
	  for (const n of nodes) {
		const t = n?.textContent?.trim();
		if (!t) continue;
		const m = t.match(/\b\d{7,}\b/);
		if (m) return m[0];
	  }
	  return null;
	}
	function clearCampaignRetry() {
	  if (_campaignRetryTimer) { clearTimeout(_campaignRetryTimer); _campaignRetryTimer = null; }
	  _campaignAttempts = 0;
	}
	function ensureCampaignIdAsync(maxAttempts = 8, delayMs = 800) {
	  const tryOnce = () => {
		const found = sniffCampaignIdFromToken() || sniffCampaignIdFromBreadcrumbs();
		if (found) { rememberMeta({ campaignId: found }); clearCampaignRetry(); return; }
		if (_campaignAttempts >= maxAttempts) { clearCampaignRetry(); return; }
		_campaignAttempts += 1;
		_campaignRetryTimer = setTimeout(tryOnce, delayMs);
	  };
	  if (!_campaignRetryTimer) tryOnce();
	}

	// --- Replacement: derive campaign/date meta from URL + UI, store TZ/dateType ---
	function deriveCampaignMetaFromUrl() {
	  const url = new URL(window.location.href);
      const reportContext = getReportContext();
      const uniquePageCampaignScope = hasUniquePageCampaignScope(reportContext);
      const trackerCampaignId = uniquePageCampaignScope ? (reportContext.trackerCampaignIds[0] || null) : null;
      const trafficSourceId = reportContext.trafficSourceId || null;

	  // URL params have priority if present
	  const pick = (keys) => {
		for (const k of keys) {
		  const v = url.searchParams.get(k);
		  if (v) return v.split(' ')[0];
		}
		return null;
	  };
	  let campaignId = null;
	  let startDate  = pick(['dateFrom','startDate','date_from']);
	  let endDate    = pick(['dateTo','endDate','date_to']);
	  let dateType   = url.searchParams.get('dateType');
	  let timeZone   = DEFAULT_TZ; // forced Moscow

      if (!reportContext.supported) {
        return {
          campaignId: null,
          sourceCampaignId: null,
          trackerCampaignId,
          trafficSourceId,
          startDate: startDate || null,
          endDate: endDate || null,
          timeZone,
          dateType,
          supported: false,
          reportContext
        };
      }

	  // Try token_3 first only when the page itself points to exactly one tracker campaign.
	  if (uniquePageCampaignScope) {
		campaignId = sniffCampaignIdFromToken();
	  }

	  // If missing date info (or dateType), read current UI
	  if (!startDate || !endDate || !dateType) {
		const ui = readDateControls();
		if (ui && ui.label) {
		  const norm = normalizePresetLabel(ui.label);
		  if (norm && norm !== 'custom-date') {
			// Preset (e.g. "Last 7 days")
			dateType = norm;
			const r = computePresetRangeUtc3(dateType);
			if (r) { startDate = r.startDate; endDate = r.endDate; }
		  } else if (norm === 'custom-date' && ui.rangeText) {
			// Custom date range like "Sep 15 -  18"
			const parsed = parseDateRangeLabel(ui.rangeText);
			if (parsed.start) startDate = parsed.start;
			if (parsed.end)   endDate   = parsed.end;
			// Keep dateType null in this path
		  }
		}
	  }

	  // If campaign still unknown, try breadcrumbs and schedule bounded retries
	  if (uniquePageCampaignScope && !campaignId) {
		campaignId = sniffCampaignIdFromBreadcrumbs();
		if (!campaignId) ensureCampaignIdAsync(); // will rememberMeta when it appears
	  }

	  // Persist TZ/dateType into meta so later calls can reuse them
	  rememberMeta({
        timeZone,
        dateType,
        trackerCampaignId,
        trackerCampaignIdsKey: serializeTrackerCampaignIds(reportContext.trackerCampaignIds || []),
        trafficSourceId,
        sourceCampaignId: uniquePageCampaignScope ? (campaignId || null) : null,
        campaignId: uniquePageCampaignScope ? (campaignId || null) : null
      });

	  return {
		campaignId: uniquePageCampaignScope ? (campaignId || null) : null,
        sourceCampaignId: uniquePageCampaignScope ? (campaignId || null) : null,
        trackerCampaignId,
        trafficSourceId,
		startDate:  startDate  || null,
		endDate:    endDate    || null,
		timeZone,
		dateType,
        supported: true,
        reportContext
	  };
	}


  function getCampaignMetaFromPage() {
    const reportContext = currentReportContext || getReportContext();
    const uniquePageCampaignScope = hasUniquePageCampaignScope(reportContext);
    const fallback = () => ({
      campaignId: uniquePageCampaignScope ? (AK_CACHE.meta.campaignId || null) : null,
      sourceCampaignId: uniquePageCampaignScope ? (AK_CACHE.meta.sourceCampaignId || null) : null,
      trackerCampaignId: uniquePageCampaignScope ? (AK_CACHE.meta.trackerCampaignId || null) : null,
      trafficSourceId: reportContext?.trafficSourceId || (uniquePageCampaignScope ? (AK_CACHE.meta.trafficSourceId || null) : null),
      trackerCampaignIdsKey: AK_CACHE.meta.trackerCampaignIdsKey || null,
      startDate: AK_CACHE.meta.startDate || null,
      endDate: AK_CACHE.meta.endDate || null,
      timeZone: AK_CACHE.meta.timeZone || null,
      dateType: AK_CACHE.meta.dateType || null,
      supported: false,
      reportContext
    });

    if (typeof deriveCampaignMetaFromUrl !== 'function') {
      warn('Campaign meta helper unavailable');
      return fallback();
    }

    try {
      const meta = deriveCampaignMetaFromUrl() || {};
      const resolvedReportContext = meta.reportContext || reportContext;
      const resolvedUniquePageCampaignScope = hasUniquePageCampaignScope(resolvedReportContext);
      return {
        campaignId: resolvedUniquePageCampaignScope ? (meta.campaignId || AK_CACHE.meta.campaignId || null) : null,
        sourceCampaignId: resolvedUniquePageCampaignScope ? (meta.sourceCampaignId || AK_CACHE.meta.sourceCampaignId || null) : null,
        trackerCampaignId: resolvedUniquePageCampaignScope ? (meta.trackerCampaignId || AK_CACHE.meta.trackerCampaignId || null) : null,
        trafficSourceId: resolvedReportContext?.trafficSourceId || meta.trafficSourceId || (resolvedUniquePageCampaignScope ? (AK_CACHE.meta.trafficSourceId || null) : null),
        trackerCampaignIdsKey: meta.trackerCampaignIdsKey || AK_CACHE.meta.trackerCampaignIdsKey || null,
        startDate: meta.startDate || AK_CACHE.meta.startDate || null,
        endDate: meta.endDate || AK_CACHE.meta.endDate || null,
        timeZone: meta.timeZone || AK_CACHE.meta.timeZone || null,
        dateType: meta.dateType || AK_CACHE.meta.dateType || null,
        supported: meta.supported !== false,
        reportContext: resolvedReportContext
      };
    } catch (error) {
      warn('Failed to derive campaign meta from URL', error);
      return fallback();
    }
  }

  function fetchMetric(entity, id, options = {}) {
    const pageMeta = getCampaignMetaFromPage();
    const reportContext = pageMeta.reportContext || getReportContext();
    const rowInfo = activeInfo && entityKey(activeInfo.entity, activeInfo.id) === entityKey(entity, id) ? activeInfo : null;
    const forceRefresh = !!options.forceRefresh;
    const actionTraceId = String(options.actionTraceId || '').trim();
    const refreshReason = String(options.refreshReason || '').trim();

    if (!pageMeta.supported || !isSupportedReportContext(reportContext)) {
      log('Metric fetch skipped - unsupported report scope', {
        entity,
        id,
        path: window.location.pathname,
        groupings: reportContext.groupings || []
      });
      return Promise.resolve(null);
    }

    const meta = buildScopeMetaForInfo(rowInfo || { entity, id }, pageMeta);
    const key = cacheKey(entity, id, meta);
    if (pendingRequests.has(key)) {
      return pendingRequests.get(key);
    }

    const entry = getMetric(entity, id, meta);
    if (!forceRefresh && entry && entry.metrics) {
      log('Metric from cache', { entity, id, scopeKey: metricScopeKey(meta) });
      return Promise.resolve(entry.metrics);
    }

    rememberMeta(sanitizeMetaForRemember(meta, reportContext));
    if (rowInfo && !isEntityAllowedByGroupingDepth(reportContext, rowInfo.entityGrouping)) {
      const groupingLabel = rowInfo.entityGrouping === (reportContext?.tokenMap?.teaserId || 'token_2')
        ? 'teaser'
        : rowInfo.entityGrouping === (reportContext?.tokenMap?.widgetId || 'token_1')
          ? 'widget'
          : 'campaign';
      setStatus(entity, id, {
        state: 'skipped',
        message: `Source stats unavailable for this ${groupingLabel} grouping depth`
      }, meta);
      log('Metric fetch skipped - grouping depth policy', {
        entity,
        id,
        entityGrouping: rowInfo.entityGrouping,
        groupings: reportContext.groupings || [],
        path: window.location.pathname
      });
      return Promise.resolve(null);
    }
    if (entity === 'campaign' && rowInfo?.campaignScopeKind === 'source' && !rowInfo?.sourceCampaignId) {
      setStatus(entity, id, {
        state: 'skipped',
        message: 'Source campaign ID is unavailable for this row'
      }, meta);
      log('Metric fetch skipped - unresolved source campaign ID', {
        entity,
        id,
        path: window.location.pathname,
        groupings: reportContext.groupings || []
      });
      return Promise.resolve(null);
    }
    if (!meta.campaignId && !rowInfo?.trackerCampaignId && !rowInfo?.trackerCampaignIds?.length) {
      setStatus(entity, id, {
        state: 'skipped',
        message: 'Campaign scope unresolved'
      }, meta);
      log('Metric fetch skipped - unresolved campaign ID', {
        entity,
        id,
        path: window.location.pathname,
        groupings: reportContext.groupings || []
      });
      return Promise.resolve(null);
    }

    const { payload } = buildEntityRequestPayload(entity, id, rowInfo, pageMeta);
    payload.type = 'AK_FETCH_ENTITY';
    if (actionTraceId) {
      payload.actionTraceId = actionTraceId;
      payload.refreshReason = refreshReason || 'action_refresh';
    }


    log('Requesting metric', {
      ...payload,
      forceRefresh,
      actionTraceId: actionTraceId || null,
      refreshReason: refreshReason || null,
      cacheKey: key
    });
    setStatus(entity, id, { state: 'loading', message: 'Loading...' }, meta);

    const promise = new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        pendingRequests.delete(key);
        log('Metric callback', {
          entity,
          id,
          forceRefresh,
          actionTraceId: actionTraceId || null,
          refreshReason: refreshReason || null,
          hasResponse: !!response,
          lastError: chrome.runtime.lastError?.message || null,
          cacheKey: key
        });
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || 'Unknown error';
          setStatus(entity, id, { state: 'error', message: msg }, meta);
          warn('Metric fetch failed', { entity, id, error: msg });
          reject(new Error(msg));
          return;
        }
        if (!response || !response.ok) {
          const message = response?.error || 'Failed to fetch metrics';
          setStatus(entity, id, { state: 'error', message }, meta);
          warn('Metric fetch error', { entity, id, error: message });
          reject(new Error(message));
          return;
        }
        clearStatus(entity, id, meta);
        setMetric(entity, id, response.data || null, { range: response.range, meta: response.meta });
        log('Metric fetched', { entity, id, hasData: !!(response && response.data) });
        resolve(response.data || null);
      });
    });

    pendingRequests.set(key, promise);
    return promise;
  }

  function collectEntityIds() {
    const rows = document.querySelectorAll('div[data-type="table-body-row"]');
    const teasers = new Set();
    const widgets = new Set();
    const campaigns = new Set();
    rows.forEach(row => {
      const info = buildEntityInfoFromRow(row);
      if (!info) return;
      if (info.entity === 'widget') {
        widgets.add(info.id);
      } else if (info.entity === 'campaign') {
        campaigns.add(info.id);
      } else {
        teasers.add(info.id);
      }
    });
    return { teasers: Array.from(teasers), widgets: Array.from(widgets), campaigns: Array.from(campaigns) };
  }

	function prefetchAllMetrics(reason = 'manual') {
	  const pageMeta = getCampaignMetaFromPage();
      const reportContext = pageMeta.reportContext || getReportContext();
      if (!pageMeta.supported || !isSupportedReportContext(reportContext)) {
        log('Prefetch skipped - unsupported report scope', {
          reason,
          path: window.location.pathname,
          groupings: reportContext.groupings || []
        });
        return;
      }
	  rememberMeta(pageMeta);

	  const { teasers, widgets, campaigns } = collectEntityIds();

	  const effectiveMeta = {
		campaignId: pageMeta.campaignId || AK_CACHE.meta.campaignId || null,
        trackerCampaignIdsKey: pageMeta.trackerCampaignIdsKey || AK_CACHE.meta.trackerCampaignIdsKey || null,
		startDate:  pageMeta.startDate  || AK_CACHE.meta.startDate  || '',
		endDate:    pageMeta.endDate    || AK_CACHE.meta.endDate    || '',
		timeZone:   AK_CACHE.meta.timeZone || 'Europe/Moscow',
		dateType:   AK_CACHE.meta.dateType || pageMeta.dateType || ''
	  };

	  // TODO(ru/en): Здесь есть race с ленивым появлением campaignId/token_3.
	  // Prefetch может уйти раньше, чем DOM дорендерится, и просто завершиться без результата.
	  // There is a race here with lazy campaignId/token_3 discovery.
	  // Prefetch can fire before the DOM is ready and simply finish without useful data.
	  if (!effectiveMeta.campaignId && (teasers.length || widgets.length)) {
		warn('Cannot prefetch metrics without campaign ID', { reason });
		return;
	  }

	  const payload = {
		type: 'AK_FETCH_METRICS',
		campaignId: effectiveMeta.campaignId || campaigns[0] || '',
        sourceCampaignId: AK_CACHE.meta.sourceCampaignId || effectiveMeta.campaignId || '',
        trackerCampaignId: AK_CACHE.meta.trackerCampaignId || '',
        trafficSourceId: AK_CACHE.meta.trafficSourceId || '',
		startDate:  effectiveMeta.startDate,
		endDate:    effectiveMeta.endDate,
		timeZone:   effectiveMeta.timeZone,
		dateType:   effectiveMeta.dateType,
		teaserIds:  teasers,
		widgetIds:  widgets,
		campaignIds: campaigns,
		hasTeasers: teasers.length > 0
	  };

	  if (!payload.teaserIds.length && !payload.widgetIds.length && !payload.campaignIds.length) {
		log('Prefetch skipped - no entities', { reason });
		return;
	  }

	  log('Prefetch metrics', {
		reason,
		campaignId: payload.campaignId,
		startDate:  payload.startDate,
		endDate:    payload.endDate,
		timeZone:   payload.timeZone,
		dateType:   payload.dateType,
		teaserCount: payload.teaserIds.length,
		widgetCount: payload.widgetIds.length,
		campaignCount: payload.campaignIds.length
	  });

	  chrome.runtime.sendMessage(payload, (response) => {
		if (chrome.runtime.lastError) {
		  warn('Prefetch failed', chrome.runtime.lastError.message);
		  return;
		}
		if (!response || response.ok === false) {
		  warn('Prefetch error', response && response.error ? response.error : 'Unknown error');
		  return;
		}

		// Reconcile meta using response.range/debug (if provided)
		let patch = {};
		if (response.range) {
		  if (response.range.startDate) patch.startDate = response.range.startDate;
		  if (response.range.endDate)   patch.endDate   = response.range.endDate;
		  if (response.range.timeZone)  patch.timeZone  = response.range.timeZone;
		  if (response.range.dateType)  patch.dateType  = response.range.dateType;
		}
		if (response.debug) {
		  if (response.debug.campaignIdUsed) patch.campaignId = response.debug.campaignIdUsed;
		  if (response.debug.sDate)          patch.startDate  = response.debug.sDate;
		  if (response.debug.eDate)          patch.endDate    = response.debug.eDate;
		  if (response.debug.timeZoneUsed)   patch.timeZone   = response.debug.timeZoneUsed;
		  if (response.debug.dateTypeUsed)   patch.dateType   = response.debug.dateTypeUsed;
		}
		if (Object.keys(patch).length) rememberMeta(patch);

		log('Prefetch completed', {
		  teaserMetrics: Object.keys(response?.data || {}).length,
		  widgetMetrics: Object.keys(response?.widgets || {}).length,
		  campaignMetrics: Object.keys(response?.campaigns || {}).length
		});
	  });
	}


  function extractNumericId(value, minDigits = 1) {
    const text = String(value || '').trim();
    if (!text) return null;
    const match = text.match(new RegExp(`\\b(\\d{${minDigits},})\\b`));
    return match ? match[1] : null;
  }

  function extractTokenValue(row, tokenNumber) {
    if (!row) return null;
    const selectors = [
      `[data-token-number="${tokenNumber}"][data-token-value]`,
      `[data-token-number="${tokenNumber}"]`,
      `[data-column="token_${tokenNumber}"]`,
      `[data-column="t${tokenNumber}"]`,
      `[data-column="token${tokenNumber}"]`
    ];
    for (const selector of selectors) {
      const nodes = row.querySelectorAll(selector);
      for (const node of nodes) {
        const candidates = [
          node?.dataset?.tokenValue,
          node?.getAttribute?.('data-token-value'),
          node?.getAttribute?.('title'),
          node?.textContent
        ];
        for (const candidate of candidates) {
          const id = extractNumericId(candidate, tokenNumber === 3 ? 7 : 1);
          if (id) return id;
        }
      }
    }
    return null;
  }

  function extractCellText(row, selectors) {
    for (const selector of selectors) {
      const node = row.querySelector(selector);
      const text = node?.textContent?.trim() || node?.getAttribute?.('title') || '';
      if (text) return text.trim();
    }
    return '';
  }

  function inferEntityType(row, reportContext = currentReportContext || getReportContext()) {
    if (!row) return 'teaser';
    if (extractTokenValue(row, 3)) return 'campaign';
    if (extractTokenValue(row, 2)) return 'teaser';
    if (extractTokenValue(row, 1)) return 'widget';
    const primaryGrouping = getPrimaryGrouping(reportContext);
    if (primaryGrouping === 'campaign' || primaryGrouping === reportContext?.tokenMap?.sourceCampaignId) return 'campaign';
    if (primaryGrouping === reportContext?.tokenMap?.widgetId) return 'widget';
    if (primaryGrouping === reportContext?.tokenMap?.teaserId) return 'teaser';
    const widgetHint = row.querySelector('[data-column*="widget" i]');
    return widgetHint ? 'widget' : 'teaser';
  }

  function extractEntityId(row, entity, reportContext = currentReportContext || getReportContext()) {
    if (!row) return null;
    const rowGrouping = getRowGrouping(row, reportContext);
    if (entity === 'campaign') {
      if (rowGrouping === (reportContext?.tokenMap?.sourceCampaignId || 'token_3')) {
        return extractTokenValue(row, 3) ||
          extractNumericId(extractCellText(row, ['div[data-column="name"]', 'div[data-column="id"]']), 7);
      }
      if (rowGrouping === 'campaign') {
        return extractTrackerCampaignRowId(row);
      }
      return extractTokenValue(row, 3) ||
        extractTrackerCampaignRowId(row) ||
        extractNumericId(extractCellText(row, ['div[data-column="name"]', 'div[data-column="id"]']), 7);
    }
    if (entity === 'widget') {
      return extractNumericId(extractCellText(row, ['div[data-column="id"]', 'div[data-column="name"]']), 1);
    }
    return extractTokenValue(row, 2) ||
      extractNumericId(extractCellText(row, ['div[data-column="id"]', 'div[data-column="name"]']), 1);
  }

  function buildEntityInfoFromRow(row) {
    if (!row) return null;
    const reportContext = getReportContext();
    if (!isSupportedReportContext(reportContext)) return null;
    const entity = inferEntityType(row, reportContext);
    const entityGrouping = getRowGrouping(row, reportContext);
    if (!SUPPORTED_GROUPINGS.has(entity === 'widget' ? reportContext.tokenMap.widgetId : entity === 'campaign' ? 'campaign' : reportContext.tokenMap.teaserId)) {
      return null;
    }
    const id = extractEntityId(row, entity, reportContext);
    const titleText = extractCellText(row, ['div[data-column="name"]', 'div[data-column="id"]']);
    if (!id && !titleText) return null;
    const campaignMeta = getCampaignMetaFromPage();
    const trackerCampaignIds = Array.isArray(reportContext.trackerCampaignIds) ? reportContext.trackerCampaignIds.slice() : [];
    const singleTrackerCampaignId = trackerCampaignIds.length === 1 ? trackerCampaignIds[0] : null;
    const uniquePageCampaignScope = hasUniquePageCampaignScope(reportContext);
    let trackerCampaignId = uniquePageCampaignScope ? (campaignMeta.trackerCampaignId || singleTrackerCampaignId || null) : null;
    let sourceCampaignId = uniquePageCampaignScope ? (campaignMeta.sourceCampaignId || campaignMeta.campaignId || null) : null;
    let campaignScopeKind = null;
    if (entity === 'campaign') {
      if (entityGrouping === (reportContext?.tokenMap?.sourceCampaignId || 'token_3')) {
        campaignScopeKind = 'source';
        sourceCampaignId = id || sourceCampaignId || null;
        trackerCampaignId = uniquePageCampaignScope ? (singleTrackerCampaignId || null) : null;
      } else {
        campaignScopeKind = 'tracker';
        trackerCampaignId = id || trackerCampaignId || null;
        sourceCampaignId = uniquePageCampaignScope ? sourceCampaignId : null;
      }
    }
    const title = titleText || id;
    const entityLabel = entity === 'widget' ? 'Widget' : (entity === 'campaign' ? 'Campaign' : 'Teaser');
    const trackerCampaignIdsKey = serializeTrackerCampaignIds(entity === 'campaign'
      ? (trackerCampaignIds.length ? trackerCampaignIds : [trackerCampaignId || ''])
      : trackerCampaignIds);
    return {
      entity,
      entityGrouping,
      id: id || title,
      trackerCampaignId,
      trackerCampaignIds,
      trackerCampaignIdsKey,
      sourceCampaignId,
      campaignScopeKind,
      trafficSourceId: reportContext.trafficSourceId || campaignMeta.trafficSourceId || null,
      title: `${entityLabel} ${title}`,
      subtitle: sourceCampaignId
        ? `Campaign ${sourceCampaignId}`
        : (trackerCampaignIdsKey ? `Scope ${trackerCampaignIdsKey}` : '')
    };
  }

  function handleMouseMove(event) {
    if (overlayPinned) return;
    if (!isSupportedReportContext()) return;
    pointerPosition = { x: event.clientX + 12, y: event.clientY + 12 };
    const row = event.target.closest('div[data-type="table-body-row"]');
    hoveredInfo = buildEntityInfoFromRow(row);
    if (ctrlPressed && hoveredInfo) {
      showOverlay(hoveredInfo);
    } else if (!ctrlPressed && !overlayPinned) {
      hideOverlay();
    } else if (ctrlPressed && !hoveredInfo && !overlayPinned) {
      hideOverlay();
    }
    updateOverlayPosition();
  }

  function handleKeyDown(event) {
    if (event.key !== 'Control') return;
    if (event.repeat) return;
    if (!isSupportedReportContext()) return;
    if (!ctrlPressed) {
      const now = Date.now();
      if (now - lastCtrlTimestamp < 350) {
        overlayPinned = !overlayPinned;
        if (overlayElement) {
          overlayElement.classList.toggle('is-pinned', overlayPinned);
          if (overlayPinnedIndicator) overlayPinnedIndicator.style.display = overlayPinned ? 'block' : 'none';
        }
        if (!overlayPinned) hideOverlay();
      }
      lastCtrlTimestamp = now;
    }
    ctrlPressed = true;
    if (hoveredInfo) {
      showOverlay(hoveredInfo);
    }
  }

  function handleKeyUp(event) {
    if (event.key !== 'Control') return;
    ctrlPressed = false;
    if (!overlayPinned) hideOverlay();
  }

  function handleBlurReset() {
    ctrlPressed = false;
    if (!overlayPinned) hideOverlay();
  }

  function handlePointerLeave() {
    if (overlayPinned) return;
    hideOverlay();
  }

  function handleScroll() {
    if (overlayPinned && overlayElement) return;
    hideOverlayIfAllowed();
  }

  function getReportActionButtonName(target) {
    if (getOverlayActionButton(target)) return '__overlay_action__';
    const button = target?.closest?.('button');
    if (!button) return null;
    const raw = button.getAttribute('aria-label') || button.getAttribute('title') || button.innerText || button.textContent || '';
    const name = String(raw).trim().toLowerCase();
    if (name === 'refresh' || name === 'apply') return name;
    return null;
  }

  function handleDocumentClick(event) {
    if (getOverlayActionButton(event.target)) {
      handleOverlayActionClick(event);
      return;
    }
    if (!isSupportedReportContext()) return;
    const action = getReportActionButtonName(event.target);
    if (action === 'refresh') {
      clearInMemoryEntityCache('report_refresh_click');
      return;
    }
    if (action === 'apply') {
      clearInMemoryEntityCache('report_apply_click');
    }
  }

  function cleanupOverlay() {
    if (!overlayElement) return;
    overlayElement.remove();
    overlayElement = null;
    overlayTitleElement = null;
    overlaySubtitleElement = null;
    overlayMetricsElement = null;
    overlayStatusElement = null;
    overlayActionsElement = null;
    overlayPinnedIndicator = null;
  }

	function cleanupHoverController() {
	  if (!hoverControllerReady) return;
	  log('Cleanup hover controller');
	  hoverControllerReady = false;

	  document.removeEventListener('mousemove', handleMouseMove, { passive: true });
	  document.removeEventListener('keydown', handleKeyDown);
	  document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('click', handleDocumentClick, true);
	  document.removeEventListener('scroll', handleScroll, { passive: true });
	  window.removeEventListener('blur', handleBlurReset);

	  // Also stop any pending campaignId bounded-retry loop
	  try { clearCampaignRetry(); } catch (_) {}

	  cleanupOverlay();
	}


  function setupHoverController() {
    if (hoverControllerReady) return;
    log('Initialize hover controller');
    hoverControllerReady = true;
    ensureOverlay();
    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('blur', handleBlurReset);
  }

  function applyWidgetMetric(id, data, info) {
    if (!id) return;
    setMetric('widget', id, data, info);
  }

  function applyTeaserMetric(id, data, info) {
    if (!id) return;
    setMetric('teaser', id, data, info);
  }

  function collectHierarchy() {
    // TODO(ru/en): Реально собрать hierarchy/maps/edges для hotkey "Copy IDs JSON".
    // Сейчас функция возвращает почти пустой каркас и слабо полезна для диагностики.
    // Actually collect hierarchy/maps/edges for the "Copy IDs JSON" hotkey.
    // Right now this returns an almost empty shell and is barely useful for diagnostics.
    return { meta: { url: location.href }, edges: [], maps: {} };
  }

  function copyToClipboard(value) {
    try {
      // TODO(ru/en): Обрабатывать Promise от clipboard API через await/catch.
      // Текущий try/catch не ловит async reject, поэтому fallback может не выполниться.
      // Handle the clipboard API Promise with await/catch.
      // The current try/catch does not catch async rejection, so the fallback may never run.
      navigator.clipboard.writeText(value);
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(textarea);
    }
  }

	chrome.runtime?.onMessage?.addListener((msg, _sender, _sendResponse) => {
	  if (!msg) return;
	  log('Runtime message', { type: msg.type });

	  if (msg.type === 'BINOM_MAGIC_INJECT_LIVE') {
		log('BINOM_MAGIC_INJECT_LIVE received');
		const meta = getCampaignMetaFromPage();
        const reportContext = meta.reportContext || getReportContext();
        if (!meta.supported || !isSupportedReportContext(reportContext)) {
          log('BINOM_MAGIC_INJECT_LIVE skipped - unsupported report scope', {
            path: window.location.pathname,
            groupings: reportContext.groupings || []
          });
          return;
        }
		rememberMeta(meta);
		setupHoverController();
		prefetchAllMetrics('context-menu');
		return;
	  }

	  if (msg.type === 'AK_DEBUG_LOG') {
		try {
		  // Surface background debug events in the page console for QA
		  log('BG', msg.event || 'DEBUG', msg.payload || {});
		} catch (_) {}
		return;
	  }

	  if (msg.type === 'AK_METRIC') {
		try {
          log('Runtime metric push', {
            entity: msg.entity,
            id: String(msg.id || ''),
            hasData: !!msg.data,
            range: msg.range || null,
            meta: msg.meta || null,
            activeEntity: activeInfo?.entity || null,
            activeId: activeInfo?.id || null
          });
		  const info = {
			range: msg.range || msg.debug || null,
			meta: msg.meta || msg.debug || null
		  };
		  if (msg.entity === 'widget') {
			applyWidgetMetric(String(msg.id), msg.data, info);
		  } else if (msg.entity === 'campaign') {
			setMetric('campaign', String(msg.id), msg.data, info);
		  } else if (msg.entity === 'teaser') {
			applyTeaserMetric(String(msg.id), msg.data, info);
		  }
		} catch (e) {
		  warn('Failed to store metric', e);
		}
		return;
	  }

	  if (msg.type === 'AK_METRIC_STATUS') {
        log('Runtime metric status', {
          entity: msg.entity || 'teaser',
          id: String(msg.id || ''),
          status: msg.status || null,
          activeEntity: activeInfo?.entity || null,
          activeId: activeInfo?.id || null
        });
		setStatus(msg.entity || 'teaser', msg.id, msg.status);
		return;
	  }

	  if (msg.type === 'BINOM_MAGIC_COPY_IDS') {
		try {
		  const data = collectHierarchy();
		  const json = JSON.stringify(data, null, 2);
		  copyToClipboard(json);
		  log('Copied IDs JSON to clipboard', data.meta?.url);
		} catch (e) {
		  warn('Failed to collect/copy IDs', e);
		}
	  }
	});


  function injectIntoRow(row) {
    if (!ENABLE_COLUMN_INJECTION) return;
    if (!row) return;
  }

  function injectHeaderOnce() {
    if (!ENABLE_COLUMN_INJECTION) return;
  }

  function injectAll() {
    if (!ENABLE_COLUMN_INJECTION) return;
  }

  function setupObserver() {}

  function initReactive() {
    currentReportContext = getReportContext();
    const meta = getCampaignMetaFromPage();
    rememberMeta(meta);
    log('Init reactive', { ...meta, reportContext: currentReportContext });
    if (!isSupportedReportContext(currentReportContext)) {
      log('Skip hover controller - unsupported report scope', {
        path: window.location.pathname,
        groupings: currentReportContext.groupings || []
      });
      cleanupHoverController();
      return;
    }
    setupHoverController();
    window.addEventListener('beforeunload', cleanupHoverController, { once: true });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initReactive();
  } else {
    window.addEventListener('DOMContentLoaded', initReactive, { once: true });
  }
  window.addEventListener('popstate', () => {
    cleanupHoverController();
    setTimeout(initReactive, 0);
  });
})();





