(() => {
  const sourceList = document.getElementById('source-list');
  const statusNode = document.getElementById('status');
  const resetStatusNode = document.getElementById('reset-status');
  let resetArmedUntil = 0;

  function showStatus(text, kind) {
    statusNode.textContent = text;
    statusNode.className = kind ? `status ${kind}` : 'status';
  }

  function showResetStatus(text, kind) {
    resetStatusNode.textContent = text;
    resetStatusNode.className = kind ? `status ${kind}` : 'status';
  }

  function sourceTemplate(source = {}, index = 0) {
    const row = document.createElement('div');
    row.className = 'source-row';
    row.dataset.index = String(index);
    row.innerHTML = `
      <div class="source-row__head">
        <div class="source-row__title">Source ${index + 1}</div>
        <button type="button" class="danger" data-remove-source>Remove</button>
      </div>
      <div class="source-grid">
        <div class="field">
          <label>Name</label>
          <input data-field="name" type="text" placeholder="Adskeeper pls NM1" value="${escapeHtml(source.name || '')}" />
        </div>
        <div class="field">
          <label>tracker_id</label>
          <input data-field="trackerId" type="text" placeholder="4" value="${escapeHtml(source.trackerId || '')}" />
        </div>
        <div class="field">
          <label>idAuth</label>
          <input data-field="idAuth" type="text" placeholder="123456" value="${escapeHtml(source.idAuth || '')}" />
        </div>
        <div class="field">
          <label>API Token</label>
          <div class="secret-wrap">
            <input data-field="apiToken" type="password" placeholder="Bearer token" autocomplete="off" value="${escapeHtml(source.apiToken || '')}" />
            <button type="button" data-toggle-secret>Show</button>
          </div>
        </div>
        <div class="field">
          <label>API Base URL</label>
          <input data-field="apiBaseUrl" type="text" placeholder="https://api.adskeeper.co.uk/v1" value="${escapeHtml(source.apiBaseUrl || '')}" />
        </div>
      </div>
    `;
    return row;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function collectSources() {
    return Array.from(sourceList.querySelectorAll('.source-row')).map((row) => {
      return {
        name: row.querySelector('[data-field="name"]').value.trim(),
        trackerId: row.querySelector('[data-field="trackerId"]').value.trim(),
        idAuth: row.querySelector('[data-field="idAuth"]').value.trim(),
        apiToken: row.querySelector('[data-field="apiToken"]').value.trim(),
        apiBaseUrl: row.querySelector('[data-field="apiBaseUrl"]').value.trim()
      };
    });
  }

  function renderSources(sources) {
    sourceList.innerHTML = '';
    const items = Array.isArray(sources) && sources.length ? sources : [{}];
    items.forEach((source, index) => {
      sourceList.appendChild(sourceTemplate(source, index));
    });
  }

  function renumberSources() {
    Array.from(sourceList.querySelectorAll('.source-row')).forEach((row, index) => {
      row.dataset.index = String(index);
      const title = row.querySelector('.source-row__title');
      if (title) title.textContent = `Source ${index + 1}`;
    });
  }

  function toggleSecret(button) {
    const explicit = button.getAttribute('data-toggle-secret');
    const input = explicit && explicit.startsWith('#')
      ? document.querySelector(explicit)
      : button.parentElement?.querySelector('input');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? 'Show' : 'Hide';
  }

  function validatePayload(payload) {
    // TODO(ru/en): Ужесточить валидацию URL: требовать https и/или whitelist доверенных host-ов
    // для tracker/API base, чтобы токены нельзя было случайно отправить на произвольный endpoint.
    // Tighten URL validation: require https and/or a trusted-host allowlist
    // for tracker/API base URLs so tokens cannot be sent to arbitrary endpoints by mistake.
    if (!payload.tracker.baseUrl) {
      return 'Tracker address is required';
    }
    if (!payload.tracker.apiToken) {
      return 'Tracker API token is required';
    }
    const invalidSource = payload.sources.find((source) => {
      const hasAny = source.name || source.trackerId || source.idAuth || source.apiToken || source.apiBaseUrl;
      if (!hasAny) return false;
      return !source.name || !source.trackerId || !source.idAuth || !source.apiToken;
    });
    if (invalidSource) {
      return 'Each filled source row must include name, tracker_id, idAuth, and API Token';
    }
    return '';
  }

  async function load() {
    const settings = await BMSecureStorage.getSettings();
    document.getElementById('tracker-base-url').value = settings.tracker?.baseUrl || '';
    document.getElementById('tracker-api-token').value = settings.tracker?.apiToken || '';
    renderSources(settings.sources || []);
  }

  async function save() {
    try {
      showStatus('', '');
      const payload = {
        tracker: {
          baseUrl: document.getElementById('tracker-base-url').value.trim(),
          apiToken: document.getElementById('tracker-api-token').value.trim()
        },
        sources: collectSources()
      };
      const validationError = validatePayload(payload);
      if (validationError) {
        showStatus(validationError, 'err');
        return;
      }
      await BMSecureStorage.saveSettings(payload);
      showStatus('Saved', 'ok');
      setTimeout(() => showStatus('', ''), 1800);
    } catch (error) {
      showStatus(error?.message || String(error), 'err');
    }
  }

  async function resetStoredData() {
    const now = Date.now();
    if (now > resetArmedUntil) {
      resetArmedUntil = now + 12000;
      showResetStatus('Click reset again within 12 seconds to confirm', 'err');
      return;
    }
    await BMSecureStorage.resetAllData();
    resetArmedUntil = 0;
    showResetStatus('Stored data removed', 'ok');
    await load();
  }

  sourceList.addEventListener('click', (event) => {
    const removeButton = event.target.closest('[data-remove-source]');
    if (removeButton) {
      removeButton.closest('.source-row')?.remove();
      if (!sourceList.children.length) renderSources([{}]);
      renumberSources();
      return;
    }
    const toggleButton = event.target.closest('[data-toggle-secret]');
    if (toggleButton) toggleSecret(toggleButton);
  });

  document.querySelector('[data-toggle-secret="#tracker-api-token"]').addEventListener('click', (event) => {
    toggleSecret(event.currentTarget);
  });

  document.getElementById('add-source').addEventListener('click', () => {
    sourceList.appendChild(sourceTemplate({}, sourceList.children.length));
    renumberSources();
  });

  document.getElementById('save').addEventListener('click', save);
  document.getElementById('reset').addEventListener('click', () => {
    resetStoredData().catch((error) => {
      resetArmedUntil = 0;
      showResetStatus(error?.message || String(error), 'err');
    });
  });
  load();
})();
