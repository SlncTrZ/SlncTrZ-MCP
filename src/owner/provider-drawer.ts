/**
 * MCP Provider Drawer — slide-in detail panel, tools browser and guarded actions.
 * Wing: owner | Topic: provider-drawer | Updated: 2026-10-09 23:01
 *
 * Self-contained Owner Console surface for inspecting one MCP provider and running
 * Test / Sync / Disable / Remove. The drawer fetches GET /owner/api/mcp/:id/detail
 * with an AbortController + generation guard so fast provider switching can never
 * let a late response overwrite the currently-selected provider. Destructive actions
 * (Disable, Remove) route through a confirmation modal with focus trap, Escape and
 * backdrop cancel that never fire a mutation until Confirm is pressed.
 *
 * Security: every provider-controlled string (name, id, endpoint, tool canonicalId,
 * description, auth metadata) is rendered via textContent / safe DOM creation — the
 * drawer never assigns provider-controlled text to innerHTML.
 */

/**
 * HTML for the drawer container, backdrop, drawer panel, tools list container,
 * actions container and the confirmation modal. All dynamic text containers are
 * empty here and populated by {@link providerDrawerScript}.
 */
export const providerDrawerHtml = `
<div id="provider-drawer-backdrop" class="provider-drawer-backdrop" hidden></div>
<aside id="provider-drawer" class="provider-drawer" role="dialog" aria-modal="true" aria-labelledby="provider-drawer-name" hidden>
  <div class="provider-drawer-panel" id="provider-drawer-panel">
    <header class="provider-drawer-header">
      <div class="provider-drawer-heading">
        <h2 id="provider-drawer-name" class="provider-drawer-title">Provider</h2>
        <div class="provider-drawer-subtitle"><code id="provider-drawer-id" class="provider-drawer-id"></code><span id="provider-drawer-status" class="status-badge" data-status="unknown"></span></div>
      </div>
      <button type="button" id="provider-drawer-close" class="provider-drawer-close" aria-label="Close details">&times;</button>
    </header>
    <div id="provider-drawer-loading" class="provider-drawer-loading" hidden>
      <span class="drawer-spinner" aria-hidden="true"></span><span>Loading provider details&hellip;</span>
    </div>
    <div id="provider-drawer-error" class="provider-drawer-error" role="alert" hidden></div>
    <div id="provider-drawer-body" class="provider-drawer-body" hidden>
      <section class="provider-drawer-section">
        <h3 class="provider-drawer-section-title">Metadata</h3>
        <dl id="provider-drawer-meta" class="provider-drawer-meta"></dl>
      </section>
      <section class="provider-drawer-section provider-drawer-tools-section">
        <div class="provider-drawer-tools-heading">
          <h3 class="provider-drawer-section-title">Tools <span id="provider-drawer-tools-count">0</span></h3>
          <input type="search" id="provider-drawer-tools-search" class="provider-drawer-tools-search" placeholder="Filter tools&hellip;" aria-label="Filter tools">
        </div>
        <div id="provider-drawer-tools" class="provider-drawer-tools" role="list"></div>
        <p id="provider-drawer-tools-empty" class="provider-drawer-empty" hidden></p>
      </section>
    </div>
    <footer id="provider-drawer-actions" class="provider-drawer-footer" hidden>
      <button type="button" id="provider-action-test" class="btn-approve" data-action="test">Test</button>
      <button type="button" id="provider-action-sync" class="btn-deny" data-action="sync">Sync</button>
      <button type="button" id="provider-action-disable" class="btn-deny" data-action="disable">Disable</button>
      <button type="button" id="provider-action-remove" class="btn-danger" data-action="remove">Remove</button>
    </footer>
  </div>
</aside>
<div id="confirm-modal-backdrop" class="confirm-modal-backdrop" hidden></div>
<div id="confirm-modal" class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title" aria-describedby="confirm-modal-body" hidden>
  <h2 id="confirm-modal-title" class="confirm-modal-title">Confirm action</h2>
  <p id="confirm-modal-body" class="confirm-modal-body"></p>
  <div class="confirm-modal-actions">
    <button type="button" id="confirm-modal-cancel" class="btn-deny">Cancel</button>
    <button type="button" id="confirm-modal-confirm" class="btn-danger">Confirm</button>
  </div>
</div>
`;

/**
 * CSS for the drawer and confirmation modal. Drawer slides in from the right over
 * 240ms with a frosted-glass header/footer, an independently scrollable tools list,
 * a 375px mobile full-width breakpoint and a centered frosted confirmation modal.
 * Reduced-motion users get instant (non-animated) transitions.
 */
export const providerDrawerCss = `
.provider-drawer-backdrop{position:fixed;inset:0;background:rgba(10,21,40,.44);z-index:60;opacity:0;transition:opacity 240ms cubic-bezier(.22,1,.36,1);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
.provider-drawer-backdrop.open{opacity:1}
.provider-drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);max-width:100%;z-index:61;transform:translateX(100%);transition:transform 240ms cubic-bezier(.22,1,.36,1);background:var(--surface,#FFFDF4);color:var(--text,#12284B);box-shadow:-16px 0 48px rgba(18,40,75,.24);display:flex;flex-direction:column}
.provider-drawer.open{transform:translateX(0)}
.provider-drawer-panel{display:flex;flex-direction:column;height:100%;min-height:0}
.provider-drawer-header{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 22px;background:var(--glass-header,rgba(255,253,244,.82));-webkit-backdrop-filter:blur(12px) saturate(1.4);backdrop-filter:blur(12px) saturate(1.4);border-bottom:1px solid var(--line,#E6DFC9);box-shadow:inset 0 -1px 0 rgba(255,255,255,.4)}
.provider-drawer-heading{min-width:0;flex:1}
.provider-drawer-title{margin:0;font-size:18px;font-weight:650;letter-spacing:-.2px;line-height:1.25;word-break:break-word}
.provider-drawer-subtitle{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px}
.provider-drawer-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--muted,#56637D);word-break:break-all}
.provider-drawer-close{flex:none;border:0;background:transparent;color:var(--muted,#56637D);font-size:24px;line-height:1;width:34px;height:34px;border-radius:8px;cursor:pointer}
.provider-drawer-close:hover{background:var(--accent-soft,#EAF3FB);color:var(--text,#12284B)}
.provider-drawer-body{flex:1;display:flex;flex-direction:column;overflow-y:auto;min-height:0;padding:16px 22px 8px}
.provider-drawer-loading{display:flex;align-items:center;gap:10px;padding:22px;color:var(--muted,#56637D);font-size:12px}
.provider-drawer-error{margin:0 22px;padding:10px 12px;border:1px solid var(--bad,#B23A4A);border-radius:8px;background:rgba(178,58,74,.08);color:var(--bad,#B23A4A);font-size:12px}
.provider-drawer-section{flex:none;margin-bottom:16px}
.provider-drawer-tools-section{flex:1;display:flex;flex-direction:column;min-height:160px;margin-bottom:0}
.provider-drawer-endpoint-toggle{cursor:pointer;font-size:12px}
.provider-drawer-endpoint-value{display:block;margin-top:4px;overflow-wrap:anywhere}
.provider-drawer-section-title{margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#56637D)}
.provider-drawer-meta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;margin:0}
.provider-drawer-meta dt{font-size:12px;color:var(--muted,#56637D);white-space:nowrap}
.provider-drawer-meta dd{margin:0;font-size:12px;color:var(--text,#12284B);word-break:break-word;min-width:0}
.provider-drawer-tools-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.provider-drawer-tools-heading .provider-drawer-section-title{margin-bottom:0}
.provider-drawer-tools-search{min-width:0;flex:1;max-width:180px;border:1px solid var(--line-strong,#CEC39E);border-radius:7px;background:var(--surface,#FFFDF4);color:var(--text,#12284B);min-height:30px;padding:5px 9px;font-size:12px}
.provider-drawer-tools-search:focus{border-color:var(--interactive,#438BC4);outline:none;box-shadow:0 0 0 3px var(--glow,rgba(67,139,196,.3))}
.provider-drawer-tools{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-right:4px}
.tool-item{border:1px solid var(--line,#E6DFC9);border-radius:8px;background:var(--surface2,#FAF3DD);padding:9px 11px}
.tool-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.tool-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--text,#12284B)}
.tool-desc{margin-top:5px;font-size:12px;color:var(--muted,#56637D);line-height:1.5;word-break:break-word}
.provider-drawer-empty{padding:16px;border:1px dashed var(--line-strong,#CEC39E);border-radius:8px;color:var(--muted,#56637D);font-size:12px;text-align:center;margin-top:12px}
.provider-drawer-footer{flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:16px 22px;background:var(--glass-header,rgba(255,253,244,.82));-webkit-backdrop-filter:blur(12px) saturate(1.4);backdrop-filter:blur(12px) saturate(1.4);border-top:1px solid var(--line,#E6DFC9)}
.provider-drawer-footer button{border-radius:7px;min-height:34px;font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer}
.btn-approve{background:var(--primary,#0055A0);color:#fff;border:1px solid var(--primary,#0055A0)}
.btn-deny{background:var(--surface,#FFFDF4);border:1px solid var(--line-strong,#CEC39E);color:var(--text,#12284B)}
.btn-danger{background:transparent;border:1px solid var(--line,#E6DFC9);color:var(--bad,#B23A4A)}
.provider-drawer-footer button:disabled,.confirm-modal-actions button:disabled{opacity:.55;cursor:not-allowed}
.status-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:650;letter-spacing:.02em;border:1px solid transparent}
.status-badge.status-ok{background:rgba(31,122,85,.12);color:var(--good,#1F7A55);border-color:rgba(31,122,85,.3)}
.status-badge.status-warn{background:rgba(150,98,15,.12);color:var(--warn,#96620F);border-color:rgba(150,98,15,.3)}
.status-badge.status-err{background:rgba(178,58,74,.1);color:var(--bad,#B23A4A);border-color:rgba(178,58,74,.3)}
.status-badge.status-muted{background:rgba(86,99,125,.1);color:var(--muted,#56637D);border-color:rgba(86,99,125,.25)}
.risk-badge{display:inline-block;flex:none;padding:1px 7px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border:1px solid transparent}
.risk-read{background:rgba(31,122,85,.12);color:var(--good,#1F7A55);border-color:rgba(31,122,85,.3)}
.risk-write{background:rgba(150,98,15,.12);color:var(--warn,#96620F);border-color:rgba(150,98,15,.3)}
.risk-network{background:rgba(67,139,196,.14);color:var(--interactive,#438BC4);border-color:rgba(67,139,196,.35)}
.risk-execute,.risk-admin{background:rgba(178,58,74,.1);color:var(--bad,#B23A4A);border-color:rgba(178,58,74,.3)}
.drawer-spinner{display:inline-block;flex:none;width:12px;height:12px;border:2px solid rgba(120,120,120,.3);border-top-color:currentColor;border-radius:50%;animation:drawer-spin .7s linear infinite}
.busy .drawer-spinner{margin-right:6px;vertical-align:-2px}
@keyframes drawer-spin{to{transform:rotate(360deg)}}
.confirm-modal-backdrop{position:fixed;inset:0;background:rgba(10,21,40,.5);z-index:70;opacity:0;transition:opacity 180ms cubic-bezier(.22,1,.36,1);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.confirm-modal-backdrop.open{opacity:1}
.confirm-modal{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 32px));max-width:440px;z-index:71;background:var(--surface,#FFFDF4);color:var(--text,#12284B);border:1px solid var(--line,#E6DFC9);border-radius:14px;box-shadow:0 24px 64px rgba(18,40,75,.32);padding:22px}
.confirm-modal-title{margin:0 0 10px;font-size:16px;font-weight:650;letter-spacing:-.2px}
.confirm-modal-body{margin:0 0 20px;font-size:12px;line-height:1.6;color:var(--muted,#56637D);word-break:break-word}
.confirm-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.confirm-modal-actions button{border-radius:7px;min-height:34px;font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer}
@media (max-width:375px){
.provider-drawer{width:100vw;max-width:100vw}
.provider-drawer-header{padding:16px 16px}
.provider-drawer-body{padding:16px}
.provider-drawer-footer{padding:14px 16px}
.provider-drawer-footer button{flex:1;min-width:0}
.confirm-modal{width:calc(100vw - 24px);padding:18px}
}
@media (prefers-reduced-motion:reduce){
.provider-drawer,.provider-drawer-backdrop,.confirm-modal,.confirm-modal-backdrop,.drawer-spinner{transition:none!important;animation:none!important}
.provider-drawer{transform:none}
}
`;

/**
 * Client-side controller. Initializes on DOMContentLoaded, exposes
 * `globalThis.SlncTrZProviderDrawer = { init, open, close, setCsrf }`, and handles:
 *  - delegated `[data-provider-open]` clicks (provider rows / "Details" buttons),
 *  - AbortController + generation guard so a stale response never renders,
 *  - Test / Sync / Disable / Remove actions with CSRF (`x-slnctrz-csrf`) headers,
 *  - a focus-trapping confirmation modal that only mutates on Confirm.
 */
export const providerDrawerScript: string = String.raw`(() => {
  'use strict';
  var q = function (id) { return document.getElementById(id); };
  var drawer = null, drawerBackdrop = null, confirmModal = null, confirmBackdrop = null;
  var generation = 0;
  var activeAbort = null;
  var currentProviderId = null;
  var currentDetail = null;
  var drawerTrigger = null;
  var modalTrigger = null;
  var pendingMutation = null;
  var tools = [];
  var toolFilter = '';
  var csrf = '';
  var csrfProvider = function () { return csrf; };
  var requestOverride = null;
  var onChanged = function () {};

  var STATUS_LABELS = {
    ready: 'Ready', connecting: 'Connecting', restarting: 'Restarting',
    auth_required: 'Auth required', needs_sync: 'Needs sync',
    unavailable: 'Unavailable', disabled: 'Disabled'
  };

  function setCsrf(value) { csrf = value; }

  function init(options) {
    options = options || {};
    if (typeof options.getCsrf === 'function') csrfProvider = options.getCsrf;
    if (typeof options.request === 'function') requestOverride = options.request;
    if (typeof options.onChanged === 'function') onChanged = options.onChanged;
  }

  function httpError(response, data) {
    var error = new Error((data && data.error && data.error.message) || ('HTTP ' + response.status));
    error.status = response.status;
    error.code = data && data.error && data.error.code;
    return error;
  }

  async function request(path, opt) {
    opt = opt || {};
    if (requestOverride) return requestOverride(path, opt);
    var headers = Object.assign(
      {},
      opt.body ? { 'content-type': 'application/json' } : {},
      opt.method && opt.method !== 'GET' ? { 'x-slnctrz-csrf': csrfProvider() } : {},
      opt.headers || {}
    );
    var response = await fetch(path, Object.assign({}, opt, { headers: headers }));
    var data;
    try { data = await response.json(); }
    catch (ignored) {
      if (!response.ok) throw httpError(response);
      var invalid = new Error('Invalid JSON response.');
      invalid.status = response.status;
      invalid.code = 'invalid_response';
      throw invalid;
    }
    if (!response.ok) throw httpError(response, data);
    return data;
  }

  function statusClass(status) {
    if (status === 'ready' || status === 'connecting') return 'ok';
    if (status === 'restarting' || status === 'needs_sync') return 'warn';
    if (status === 'auth_required' || status === 'unavailable') return 'err';
    return 'muted';
  }

  function renderStatus(detail) {
    var badge = q('provider-drawer-status');
    var status = detail.status || (detail.enabled === false ? 'disabled' : 'unavailable');
    badge.textContent = STATUS_LABELS[status] || String(status);
    badge.className = 'status-badge status-' + statusClass(status);
    badge.dataset.status = status;
  }

  function addMeta(dl, label, value) {
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value || '\u2014';
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderMeta(detail) {
    var dl = q('provider-drawer-meta');
    dl.replaceChildren();
    var conn = detail.connection || {};
    addMeta(dl, 'Transport', conn.kind === 'local' ? 'Local (stdio)' : 'Remote (streamable-http)');
    if (conn.kind === 'local' && conn.command) {
      var dt = document.createElement('dt');
      dt.textContent = 'Command';
      var dd = document.createElement('dd');
      var reveal = document.createElement('details');
      var toggle = document.createElement('summary');
      toggle.className = 'provider-drawer-endpoint-toggle';
      toggle.textContent = '\u25c9 Show command';
      var value = document.createElement('code');
      value.className = 'provider-drawer-endpoint-value';
      value.textContent = conn.command;
      reveal.addEventListener('toggle', function () {
        toggle.textContent = reveal.open ? '\u25c9 Hide command' : '\u25c9 Show command';
      });
      reveal.appendChild(toggle);
      reveal.appendChild(value);
      dd.appendChild(reveal);
      dl.appendChild(dt);
      dl.appendChild(dd);
    } else addMeta(dl, 'Endpoint', conn.endpoint || '');
    var identity = detail.identity || {};
    addMeta(dl, 'Provider', identity.name || 'Not reported');
    addMeta(dl, 'Provider version', identity.version || 'Not reported');
    addMeta(dl, 'Protocol', identity.protocolVersion || 'Unknown');
    addMeta(dl, 'Observed', identity.observedAt ? new Date(identity.observedAt).toLocaleString() : 'Not observed');
    var auth = detail.auth || {};
    if (auth.kind && auth.kind !== 'none') {
      var authLabel = auth.kind === 'header' ? 'HTTP header' : auth.kind === 'bearer' ? 'Bearer token' : 'Environment variable';
      addMeta(dl, 'Auth', authLabel + (auth.name ? ' \u00b7 ' + auth.name : ''));
    } else {
      addMeta(dl, 'Auth', 'None');
    }
    var health = detail.health || {};
    addMeta(dl, 'Last successful probe', health.lastProbeAt ? new Date(health.lastProbeAt).toLocaleString() : 'Not recorded this session');
  }

  function applyToolFilter() {
    var container = q('provider-drawer-tools');
    var empty = q('provider-drawer-tools-empty');
    container.replaceChildren();
    var needle = toolFilter.trim().toLowerCase();
    var visible = tools.filter(function (tool) {
      if (!needle) return true;
      return String(tool.canonicalId || '').toLowerCase().indexOf(needle) !== -1 ||
        String(tool.description || '').toLowerCase().indexOf(needle) !== -1;
    });
    if (visible.length === 0) {
      empty.hidden = false;
      empty.textContent = tools.length ? 'No tools match your filter.' : 'No tools accepted yet.';
      return;
    }
    empty.hidden = true;
    visible.forEach(function (tool) {
      var item = document.createElement('div');
      item.className = 'tool-item';
      item.setAttribute('role', 'listitem');
      var row = document.createElement('div');
      row.className = 'tool-row';
      var id = document.createElement('code');
      id.className = 'tool-id';
      id.textContent = tool.canonicalId;
      var badge = document.createElement('span');
      badge.className = 'risk-badge risk-' + (tool.riskClass || 'unknown');
      badge.textContent = tool.riskClass || 'unknown';
      row.appendChild(id);
      row.appendChild(badge);
      item.appendChild(row);
      if (tool.description) {
        var desc = document.createElement('div');
        desc.className = 'tool-desc';
        desc.textContent = tool.description;
        item.appendChild(desc);
      }
      container.appendChild(item);
    });
  }

  function renderTools(detail) {
    tools = (detail.tools && detail.tools.accepted) || [];
    q('provider-drawer-tools-count').textContent = String(tools.length);
    applyToolFilter();
  }

  function renderActions(detail) {
    currentDetail = detail;
    var disabling = detail.enabled !== false;
    q('provider-action-disable').textContent = disabling ? 'Disable' : 'Enable';
    q('provider-action-disable').dataset.targetEnabled = disabling ? 'false' : 'true';
  }

  function render(detail) {
    currentDetail = detail;
    q('provider-drawer-name').textContent = detail.name || detail.id;
    q('provider-drawer-id').textContent = detail.id;
    renderStatus(detail);
    renderMeta(detail);
    renderTools(detail);
    renderActions(detail);
    q('provider-drawer-body').hidden = false;
    q('provider-drawer-actions').hidden = false;
  }

  function setLoading(loading) {
    q('provider-drawer-loading').hidden = !loading;
  }

  function showError(error) {
    var el = q('provider-drawer-error');
    var message = error && error.message ? error.message : 'The request could not be completed.';
    if (error && error.name === 'AbortError') return;
    el.textContent = String(message);
    el.hidden = false;
  }

  function clearError() {
    q('provider-drawer-error').hidden = true;
    q('provider-drawer-error').textContent = '';
  }

  function setBusy(buttonId, busy) {
    var btn = q(buttonId);
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
    btn.setAttribute('aria-busy', String(busy));
    if (busy) {
      if (!btn.querySelector('.drawer-spinner')) {
        var spin = document.createElement('span');
        spin.className = 'drawer-spinner';
        spin.setAttribute('aria-hidden', 'true');
        btn.prepend(spin);
      }
    } else {
      var existing = btn.querySelector('.drawer-spinner');
      if (existing) existing.remove();
    }
  }

  function showDrawer() {
    var myGeneration = generation;
    drawer.hidden = false;
    drawerBackdrop.hidden = false;
    requestAnimationFrame(function () {
      if (myGeneration !== generation || !currentProviderId) return;
      drawer.classList.add('open');
      drawerBackdrop.classList.add('open');
    });
    q('provider-drawer-close').focus();
  }

  function close() {
    generation += 1;
    if (activeAbort) activeAbort.abort();
    activeAbort = null;
    currentProviderId = null;
    currentDetail = null;
    if (!drawer) return;
    closeConfirmation();
    drawer.classList.remove('open');
    drawerBackdrop.classList.remove('open');
    window.setTimeout(function () {
      if (!drawer.classList.contains('open')) {
        drawer.hidden = true;
        drawerBackdrop.hidden = true;
      }
    }, 260);
    if (drawerTrigger && drawerTrigger.focus) drawerTrigger.focus();
    drawerTrigger = null;
  }

  async function refresh(providerId, myGeneration) {
    if (myGeneration !== generation || providerId !== currentProviderId) return;
    if (activeAbort) activeAbort.abort();
    activeAbort = new AbortController();
    try {
      var detail = await request('/owner/api/mcp/' + encodeURIComponent(providerId) + '/detail', { method: 'GET', signal: activeAbort.signal });
      if (myGeneration !== generation || providerId !== currentProviderId) return;
      render(detail);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (myGeneration !== generation || providerId !== currentProviderId) return;
      showError(error);
    }
  }

  async function open(providerId, trigger) {
    providerId = String(providerId || '');
    if (!providerId) return;
    generation += 1;
    var myGeneration = generation;
    if (activeAbort) activeAbort.abort();
    activeAbort = new AbortController();
    closeConfirmation();
    currentDetail = null;
    tools = [];
    toolFilter = '';
    q('provider-drawer-body').hidden = true;
    q('provider-drawer-actions').hidden = true;
    q('provider-drawer-meta').replaceChildren();
    q('provider-drawer-tools').replaceChildren();
    q('provider-drawer-tools-search').value = '';
    q('provider-drawer-tools-empty').hidden = true;
    ['test', 'sync', 'disable', 'remove'].forEach(function (action) { setBusy('provider-action-' + action, false); });
    currentProviderId = providerId;
    drawerTrigger = trigger || document.activeElement;
    showDrawer();
    q('provider-drawer-name').textContent = providerId;
    q('provider-drawer-id').textContent = providerId;
    renderStatus({ status: 'connecting' });
    clearError();
    setLoading(true);
    try {
      var detail = await request('/owner/api/mcp/' + encodeURIComponent(providerId) + '/detail', { method: 'GET', signal: activeAbort.signal });
      if (myGeneration !== generation || providerId !== currentProviderId) return;
      render(detail);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (myGeneration !== generation || providerId !== currentProviderId) return;
      showError(error);
    } finally {
      if (myGeneration === generation) setLoading(false);
    }
  }

  function hideConfirmation() {
    confirmBackdrop.classList.remove('open');
    confirmModal.hidden = true;
    confirmBackdrop.hidden = true;
  }

  function closeConfirmation() {
    pendingMutation = null;
    if (confirmModal && confirmBackdrop) hideConfirmation();
    if (modalTrigger && modalTrigger.focus) modalTrigger.focus();
    modalTrigger = null;
  }

  function openConfirmation(options) {
    pendingMutation = options;
    q('confirm-modal-title').textContent = options.title;
    q('confirm-modal-body').textContent = options.body;
    var confirmBtn = q('confirm-modal-confirm');
    confirmBtn.textContent = options.confirmLabel || 'Confirm';
    confirmBtn.className = options.danger === false ? 'btn-deny' : 'btn-danger';
    confirmBtn.disabled = false;
    confirmBackdrop.hidden = false;
    confirmModal.hidden = false;
    requestAnimationFrame(function () { if (pendingMutation === options && !confirmModal.hidden) confirmBackdrop.classList.add('open'); });
    q('confirm-modal-cancel').focus();
  }

  async function runAction(actionId, providerId, mutate, remove) {
    var myGeneration = generation;
    if (providerId !== currentProviderId) return;
    setBusy(actionId, true);
    clearError();
    try {
      await mutate();
      if (myGeneration === generation && providerId === currentProviderId && remove) close();
      await onChanged();
      if (!remove) await refresh(providerId, myGeneration);
    } catch (error) {
      if (myGeneration === generation && providerId === currentProviderId && error?.name !== 'AbortError') showError(error);
    } finally {
      if (myGeneration === generation && providerId === currentProviderId) setBusy(actionId, false);
    }
  }

  function requestDisableConfirm() {
    var detail = currentDetail;
    if (!detail) return;
    var disabling = detail.enabled !== false;
    modalTrigger = q('provider-action-disable');
    openConfirmation({
      title: disabling ? 'Disable provider?' : 'Enable provider?',
      body: disabling
        ? 'Disabling ' + detail.name + ' stops every client from using its tools until you re-enable it. Existing grants are preserved but the provider will not run.'
        : 'Enabling ' + detail.name + ' makes its accepted tools available to clients again according to their grants.',
      confirmLabel: disabling ? 'Disable' : 'Enable',
      danger: disabling,
      actionId: 'provider-action-disable',
      providerId: detail.id,
      generation: generation,
      run: function () {
        return request('/owner/api/mcp/' + encodeURIComponent(detail.id), { method: 'PATCH', body: JSON.stringify({ enabled: !disabling }) });
      }
    });
  }

  function requestRemoveConfirm() {
    var detail = currentDetail;
    if (!detail) return;
    modalTrigger = q('provider-action-remove');
    openConfirmation({
      title: 'Remove provider?',
      body: 'Removing ' + detail.name + ' permanently deletes this provider and all of its tool grants. This action cannot be undone.',
      confirmLabel: 'Remove',
      danger: true,
      actionId: 'provider-action-remove',
      providerId: detail.id,
      generation: generation,
      remove: true,
      run: function () {
        return request('/owner/api/mcp/' + encodeURIComponent(detail.id), { method: 'DELETE', body: '{}' });
      }
    });
  }

  async function handleConfirm() {
    var mutation = pendingMutation;
    if (!mutation) return;
    closeConfirmation();
    if (mutation.generation !== generation || mutation.providerId !== currentProviderId) return;
    await runAction(mutation.actionId, mutation.providerId, mutation.run, mutation.remove);
  }

  function trapTab(event, container) {
    var focusables = Array.prototype.slice.call(
      container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (focusables.length === 0) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    drawer = q('provider-drawer');
    drawerBackdrop = q('provider-drawer-backdrop');
    confirmModal = q('confirm-modal');
    confirmBackdrop = q('confirm-modal-backdrop');

    q('provider-drawer-close').addEventListener('click', close);
    drawerBackdrop.addEventListener('click', close);
    confirmBackdrop.addEventListener('click', closeConfirmation);
    q('confirm-modal-cancel').addEventListener('click', closeConfirmation);
    q('confirm-modal-confirm').addEventListener('click', handleConfirm);
    q('provider-drawer-tools-search').addEventListener('input', function (event) {
      toolFilter = event.target.value;
      applyToolFilter();
    });

    ['test', 'sync'].forEach(function (action) {
      q('provider-action-' + action).addEventListener('click', function () {
        var id = currentProviderId;
        if (!id || !currentDetail) return;
        return runAction('provider-action-' + action, id, function () {
          return request('/owner/api/mcp/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: '{}' });
        }, false);
      });
    });

    q('provider-action-disable').addEventListener('click', requestDisableConfirm);
    q('provider-action-remove').addEventListener('click', requestRemoveConfirm);
  });

  document.addEventListener('click', function (event) {
    var target = event.target;
    var trigger = target && target.closest ? target.closest('[data-provider-open]') : null;
    if (!trigger) return;
    event.preventDefault();
    var providerId = trigger.getAttribute('data-provider-id');
    if (providerId) open(providerId, trigger);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (confirmModal && !confirmModal.hidden) { event.preventDefault(); closeConfirmation(); }
      else if (drawer && !drawer.hidden) { event.preventDefault(); close(); }
      return;
    }
    if (event.key === 'Tab' && confirmModal && !confirmModal.hidden) trapTab(event, confirmModal);
    else if (event.key === 'Tab' && drawer && !drawer.hidden) trapTab(event, drawer);
  });

  globalThis.SlncTrZProviderDrawer = { init: init, open: open, close: close, setCsrf: setCsrf };
})();
`;
