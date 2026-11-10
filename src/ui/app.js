const api = window.nearlink;
const { icon } = Icons;

const ACTIVE = ['queued', 'running'];
const TABS = ['devices', 'files', 'transfers', 'shared'];
const SETTINGS_SECTIONS = ['computer', 'trusted', 'network', 'about'];

let state;
const ui = {
  tab: 'devices',
  settingsOpen: false,
  settingsSection: 'computer',
  // Network pane
  device: null,
  share: null,
  path: '',
  remote: null,
  remoteLoading: false,
  remoteLocation: '',
  // Local pane
  local: null,
  localLoading: false,
};
const panes = { local: FileView.defaults(), network: FileView.defaults() };
const picks = { local: new Set(), network: new Set() };
const drag = { source: null, external: false, timer: null };
const busy = new WeakSet();
let remoteGeneration = 0;
let localGeneration = 0;
let preferencesLoaded = false;

// ── Small helpers ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const platformName = p =>
  p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p || 'Computer';
const deviceIcon = p => (p === 'darwin' ? 'laptop' : 'monitor');
const keyOf = (side, entry) => (side === 'local' ? entry.id : entry.name);
const entriesOf = side => (side === 'local' ? ui.local?.entries : ui.remote?.entries) || [];
const remotePath = name => (ui.path ? ui.path + '/' + name : name);
const currentDevice = () => state.devices.find(d => d.id === ui.device);

function bytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function button(action, content, { cls = 'button', attrs = '', disabled = false } = {}) {
  return `<button class="${cls}" data-action="${action}" ${attrs}${disabled ? ' disabled' : ''}>${content}</button>`;
}

function iconButton(action, name, label, { attrs = '', disabled = false } = {}) {
  return button(action, icon(name), {
    cls: 'icon-button',
    attrs: `title="${esc(label)}" aria-label="${esc(label)}" ${attrs}`,
    disabled,
  });
}

function pageHead(eyebrow, title, description, actions = '') {
  return `<header class="page__head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="page__actions">${actions}</div></header>`;
}

function empty(iconName, heading, description, action = '') {
  return `<div class="empty"><span class="empty__icon">${icon(iconName)}</span><h3>${heading}</h3><p>${description}</p>${action}</div>`;
}

function chip(label, kind = '') {
  return `<span class="chip ${kind}"><span class="status-dot ${kind}"></span>${label}</span>`;
}

// ── Toasts ───────────────────────────────────────────────────────────────
function toast(message, kind = 'error') {
  const text = String(message).replace(/^Error invoking remote method '[^']+': Error: /, '');
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.innerHTML = `<span class="toast__icon">${icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info')}</span><span class="toast__message"></span><button class="toast__close" aria-label="Dismiss">${icon('close')}</button><span class="toast__progress"></span>`;
  node.querySelector('.toast__message').textContent = text;
  const dismiss = () => node.remove();
  node.querySelector('.toast__close').addEventListener('click', dismiss);
  setTimeout(dismiss, 6000);
  $('toasts').append(node);
  while ($('toasts').children.length > 3) $('toasts').firstElementChild.remove();
}

// ── Chrome: header, tabs, sidebar ────────────────────────────────────────
function renderChrome() {
  const active = state.transfers.filter(t => ACTIVE.includes(t.status)).length;
  $('tabs').dataset.view = ui.tab;
  for (const tab of $('tabs').querySelectorAll('[data-tab]')) {
    const on = tab.dataset.tab === ui.tab;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-current', on ? 'page' : 'false');
  }
  $('transfer-count').hidden = !active;
  $('transfer-count').textContent = active || '';
  $('device-count').textContent = state.devices.length;
  if (document.activeElement !== $('self-name')) $('self-name').value = state.self.name;

  const addresses = state.network?.addresses || [];
  morph(
    $('net-status'),
    addresses.length
      ? `<span class="status-dot is-ok"></span><span>${esc(addresses[0])}</span><span class="app-header__sep">·</span><span>${state.devices.length ? plural(state.devices.length, 'computer') + ' nearby' : 'Listening'}</span>`
      : `<span class="status-dot is-bad"></span><span>No local network found</span>`,
  );

  morph(
    $('device-list'),
    state.devices.length
      ? state.devices
          .map(
            d =>
              `<button class="device-row ${ui.tab === 'files' && ui.device === d.id ? 'is-active' : ''}" data-action="open-device" data-id="${esc(d.id)}" data-key="${esc(d.id)}"><span class="device-row__icon">${icon(deviceIcon(d.platform))}</span><span class="device-row__text"><strong>${esc(d.name)}</strong><small>${d.paired ? 'Paired' : 'Not paired yet'}</small></span><span class="status-dot ${d.paired ? 'is-ok' : ''}"></span></button>`,
          )
          .join('')
      : `<div class="sidebar-empty"><span class="pulse" aria-hidden="true"></span><p>No other computers online.<br />Listening on your network…</p></div>`,
  );
}

// ── Devices page ─────────────────────────────────────────────────────────
function networkHelp() {
  const n = state.network;
  if (!n) return '';
  const mac = state.self.platform === 'darwin';
  return `<div class="notice">
    <span class="notice__icon">${icon('wifi')}</span>
    <div>
      <h3>Connection help</h3>
      <p>${n.addresses.length ? 'This computer is at ' + n.addresses.map(esc).join(', ') + '.' : 'No supported local network found. Connect to your home or office network.'}</p>
      ${n.failures.map(f => `<p class="notice__detail">Found a device at ${esc(f.address)}, but could not connect: ${esc(f.message)}</p>`).join('')}
      <p>${mac ? 'On this Mac, open System Settings → Privacy &amp; Security → Local Network and turn on Nearlink.' : 'Allow Nearlink through Windows Firewall on Private networks.'} Both computers must be on the same network.</p>
      <div class="notice__actions">${button('network-settings', (mac ? 'Open Local Network settings' : 'Open network settings') + icon('external'), { cls: 'button button--small' })}${button('refresh', 'Try again', { cls: 'button button--quiet button--small' })}</div>
    </div>
  </div>`;
}

function devicesPage() {
  const online = new Set(state.devices.map(d => d.id));
  const offline = state.trusted.filter(t => !online.has(t.id));
  const cards = state.devices
    .map(
      d => `<article class="device-card ${d.paired ? 'is-paired' : ''}" data-key="${esc(d.id)}">
        <div class="device-card__head">
          <span class="tile-icon">${icon(deviceIcon(d.platform))}</span>
          <div><h3>${esc(d.name)}</h3><small>${esc(platformName(d.platform))} · ${esc(d.host)}</small></div>
        </div>
        <div class="device-card__foot">
          ${d.paired ? chip('Paired', 'is-ok') : chip('Not paired')}
          ${
            d.paired
              ? button('open-device', 'Browse files' + icon('arrowRight'), {
                  cls: 'button button--primary button--small',
                  attrs: `data-id="${esc(d.id)}"`,
                })
              : button('pair', icon('link') + 'Pair', { cls: 'button button--small', attrs: `data-id="${esc(d.id)}"` })
          }
        </div>
      </article>`,
    )
    .join('');

  const searching = `<div class="searching">
    <div class="launch__loader" aria-hidden="true"><div class="launch__orbit"></div><div class="launch__orbit launch__orbit--counter"></div><span class="launch__core">${icon('wifi')}</span></div>
    <h3>Looking for your other computers</h3>
    <p>Open Nearlink on a Mac or Windows PC on the same network. It appears here on its own.</p>
  </div>`;

  return `<section class="page" data-key="devices">
    ${pageHead('Nearby', 'Computers on your network', 'Pair once, then browse shared folders and send files directly. Nothing leaves your network.')}
    ${state.devices.length ? `<div class="device-grid">${cards}</div>` : searching + networkHelp()}
    ${
      offline.length
        ? `<div class="section-title"><h2>Paired, currently offline</h2><span>They reappear when Nearlink is open on them</span></div>
           <div class="row-list">${offline.map(t => `<div class="row" data-key="${esc(t.id)}"><span class="tile-icon tile-icon--dim">${icon('laptop')}</span><div class="row__title"><strong>${esc(t.name)}</strong><span>Paired ${new Date(t.pairedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span></div>${chip('Offline')}</div>`).join('')}</div>`
        : ''
    }
    ${state.warnings.map(w => `<div class="notice notice--warn"><span class="notice__icon">${icon('alert')}</span><div><p>${esc(w)}</p></div></div>`).join('')}
  </section>`;
}

// ── Files page ───────────────────────────────────────────────────────────
function viewControls(side, enabled) {
  const p = panes[side];
  const modes = [
    ['list', 'list', 'List'],
    ['grid', 'grid', 'Grid'],
    ['details', 'details', 'Details'],
  ];
  const sorts = [
    ['name', 'Name'],
    ['size', 'Size'],
    ['type', 'Type'],
    ['modified', 'Date modified'],
  ];
  return `<div class="pane__controls">
    <label class="search">${icon('search')}<input type="search" data-search="${side}" aria-label="Search this folder" placeholder="Search this folder" value="${esc(p.query)}" autocomplete="off" spellcheck="false"${enabled ? '' : ' disabled'}></label>
    <div class="ui-segmented" data-index="${modes.findIndex(m => m[0] === p.view)}" role="group" aria-label="View">
      <span class="ui-segmented__thumb"></span>
      ${modes.map(([mode, name, label]) => button('view-mode', icon(name), { cls: p.view === mode ? 'is-active' : '', attrs: `data-side="${side}" data-mode="${mode}" title="${label} view" aria-label="${label} view" aria-pressed="${p.view === mode}"` })).join('')}
    </div>
    <select class="select" data-sort="${side}" aria-label="Sort by">${sorts.map(([value, label]) => `<option value="${value}"${p.sort === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
    ${iconButton('sort-direction', p.direction === 'asc' ? 'arrowUp' : 'arrowDown', p.direction === 'asc' ? 'Ascending. Click to reverse' : 'Descending. Click to reverse', { attrs: `data-side="${side}"` })}
  </div>`;
}

function fileRows(side) {
  const options = panes[side];
  const chosen = picks[side];
  const shown = FileView.visible(entriesOf(side), options);
  if (!shown.length) {
    return options.query
      ? `<div class="pane__empty">No matches for “${esc(options.query)}”.<small>Search checks names in this folder only.</small>${button('clear-search', 'Clear search', { cls: 'button button--quiet button--small', attrs: `data-side="${side}"` })}</div>`
      : `<div class="pane__empty">This folder is empty.</div>`;
  }
  const checkbox = e =>
    `<input type="checkbox" data-pick-side="${side}" data-index="${e.index}" aria-label="Select ${esc(e.name)}"${chosen.has(keyOf(side, e)) ? ' checked' : ''}>`;
  const selectAll = `<input type="checkbox" data-select-all="${side}" aria-label="Select all"${shown.every(e => chosen.has(keyOf(side, e))) ? ' checked' : ''}>`;
  const name = e =>
    e.directory
      ? button('open-entry', `${icon('folder')}<span>${esc(e.name)}</span>`, {
          cls: 'file-name file-name--folder',
          attrs: `data-side="${side}" data-index="${e.index}" title="Open ${esc(e.name)}"`,
        })
      : `<span class="file-name" title="${esc(e.name)}">${icon('file')}<span>${esc(e.name)}</span></span>`;
  const rowAttrs = e =>
    `draggable="true" data-drag-side="${side}" data-drag-index="${e.index}" data-key="${esc(String(keyOf(side, e)))}"`;

  if (options.view === 'grid') {
    return `<div class="grid-select"><label>${selectAll}Select all</label></div>
      <div class="file-grid">${shown.map(e => `<article ${rowAttrs(e)} class="file-tile ${chosen.has(keyOf(side, e)) ? 'is-selected' : ''}"><label class="file-tile__pick">${checkbox(e)}</label>${name(e)}<small>${e.directory ? 'Folder' : bytes(e.size)}</small></article>`).join('')}</div>`;
  }
  const details = options.view === 'details';
  const modified = e => new Date(e.modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `<table class="files ${details ? 'files--details' : ''}">
    <thead><tr><th class="files__pick">${selectAll}</th><th>Name</th><th class="files__size">Size</th>${details ? '<th>Type</th><th>Modified</th>' : ''}</tr></thead>
    <tbody>${shown.map(e => `<tr ${rowAttrs(e)} class="${chosen.has(keyOf(side, e)) ? 'is-selected' : ''}"><td class="files__pick">${checkbox(e)}</td><td>${name(e)}</td><td class="files__size">${e.directory ? '—' : bytes(e.size)}</td>${details ? `<td>${esc(FileView.type(e))}</td><td>${modified(e)}</td>` : ''}</tr>`).join('')}</tbody>
  </table>`;
}

function paneSummary(side) {
  const total = entriesOf(side).length;
  const shown = FileView.visible(entriesOf(side), panes[side]).length;
  const selected = picks[side].size ? `${picks[side].size} selected · ` : '';
  return selected + (panes[side].query ? `${shown} of ${plural(total, 'item')}` : plural(total, 'item'));
}

function localPane(device) {
  const folder = ui.local;
  const share = ui.share;
  const canSend = !!(device?.paired && share?.writable && !ui.remoteLoading && !ui.localLoading && picks.local.size);
  const filesOnly = !!folder && folder.entries.filter(e => picks.local.has(e.id)).every(e => !e.directory);
  const destination = share
    ? share.writable
      ? `To ${esc(share.name)}${ui.path ? '/' + esc(ui.path) : ''}`
      : 'The open shared folder is read-only'
    : 'Open a shared folder on the right as the destination';
  const list = ui.localLoading
    ? '<div class="pane__empty">Opening folder…</div>'
    : folder
      ? fileRows('local')
      : empty(
          'folder',
          'Browse this computer',
          'Choose any folder or connected drive.',
          button('local-choose', 'Choose folder…'),
        );
  return `<section class="pane" data-drop-side="local" aria-label="Files on this computer">
    <div class="pane__head">
      <div><div class="eyebrow">This computer</div><h2>${esc(state.self.name)}</h2></div>
      ${button('local-choose', 'Choose folder…', { cls: 'button button--quiet button--small' })}
    </div>
    <div class="pane__path">
      ${iconButton('local-up', 'arrowUp', 'Parent folder', { disabled: !folder?.parent || ui.localLoading })}
      ${iconButton('local-home', 'home', 'Home folder')}
      <span class="pane__crumb" title="${esc(folder?.path || '')}">&lrm;${esc(folder?.path || 'Home')}</span>
      ${iconButton('local-refresh', 'refresh', 'Refresh this folder')}
    </div>
    ${viewControls('local', !!folder && !ui.localLoading)}
    <div class="pane__list">${list}</div>
    <div class="pane__foot">
      <div class="pane__summary"><strong>${paneSummary('local')}</strong><span>${destination}</span></div>
      <div class="pane__actions">
        ${button('move-send', 'Move', { cls: 'button button--small', disabled: !(canSend && filesOnly) })}
        ${button('copy-send', 'Copy' + icon('arrowRight'), { cls: 'button button--primary button--small', disabled: !canSend })}
      </div>
    </div>
  </section>`;
}

function networkPane(device) {
  const share = ui.share;
  let content;
  if (!ui.device) {
    content = state.devices.length
      ? `<div class="pick-list">${state.devices.map(d => `<button class="pick-row" data-action="open-device" data-id="${esc(d.id)}" data-key="${esc(d.id)}"><span class="tile-icon">${icon(deviceIcon(d.platform))}</span><span class="pick-row__text"><strong>${esc(d.name)}</strong><small>${d.paired ? 'Browse shared folders' : 'Pair to browse'}</small></span>${icon('arrowRight')}</button>`).join('')}</div>`
      : empty('wifi', 'No computers online', 'Open Nearlink on another computer connected to your network.');
  } else if (!device) {
    content = empty(
      'wifi',
      'Computer disconnected',
      'Its files will be available again when it reconnects.',
      button('network-root', 'All computers'),
    );
  } else if (!device.paired) {
    content = empty(
      'link',
      'Pair these computers first',
      'Compare and approve the matching code on both computers.',
      button('pair', 'Pair with ' + esc(device.name), {
        cls: 'button button--primary',
        attrs: `data-id="${esc(device.id)}"`,
      }),
    );
  } else if (ui.remoteLoading) {
    content = '<div class="pane__empty">Opening shared folders…</div>';
  } else if (!ui.remote) {
    content = empty(
      'refresh',
      'Ready to browse',
      'Refresh to load this computer’s shared folders.',
      button('remote-refresh', 'Refresh'),
    );
  } else if (!share) {
    content = ui.remote.shares?.length
      ? `<div class="pick-list">${ui.remote.shares.map(s => `<button class="pick-row" data-action="open-share" data-id="${esc(s.id)}" data-key="${esc(s.id)}"><span class="tile-icon">${icon('folder')}</span><span class="pick-row__text"><strong>${esc(s.name)}</strong><small>${s.writable ? 'Read and write' : 'Read-only'}</small></span>${icon('arrowRight')}</button>`).join('')}</div>`
      : empty(
          'folder',
          'No folders shared yet',
          `On ${esc(device.name)}, open Shared folders and share a folder. It will appear here.`,
        );
  } else {
    content = fileRows('network');
  }

  const crumb = device
    ? device.name +
      (share ? ' / ' + share.name + (ui.path ? ' / ' + ui.path.split('/').join(' / ') : '') : ' / Shared folders')
    : 'All computers';
  const ready = !!(device?.paired && share && !ui.remoteLoading);
  const canAdd = ready && share.writable;
  const canReceive = ready && picks.network.size > 0 && !!ui.local && !ui.localLoading;
  const filesOnly =
    !!ui.remote?.entries && ui.remote.entries.filter(e => picks.network.has(e.name)).every(e => !e.directory);

  return `<section class="pane" data-drop-side="network" aria-label="Files on the network">
    <div class="pane__head">
      <div><div class="eyebrow">Local network</div><h2>${device ? esc(device.name) : 'Your computers'}</h2></div>
      ${button('network-root', 'All computers', { cls: 'button button--quiet button--small', disabled: !ui.device })}
    </div>
    <div class="pane__path">
      ${iconButton('remote-up', 'arrowUp', 'Parent folder', { disabled: !ui.device })}
      <span class="pane__crumb" title="${esc(crumb)}">&lrm;${esc(crumb)}</span>
      ${iconButton('remote-refresh', 'refresh', 'Refresh')}
    </div>
    ${viewControls('network', ready)}
    <div class="pane__list">${content}</div>
    <div class="pane__foot">
      <div class="pane__summary"><strong>${share ? paneSummary('network') : device?.paired ? 'Paired' : '&nbsp;'}</strong><span>${ui.local ? 'To ' + esc(ui.local.path) : 'Choose a local folder on the left'}</span></div>
      <div class="pane__actions">
        ${button('send-files', 'Add files…', { cls: 'button button--quiet button--small', disabled: !canAdd })}
        ${button('send-folder', 'Add folder…', { cls: 'button button--quiet button--small', disabled: !canAdd })}
        ${button('move-receive', 'Move', { cls: 'button button--small', disabled: !(canReceive && share.writable && filesOnly) })}
        ${button('copy-receive', icon('arrowLeft') + 'Copy', { cls: 'button button--primary button--small', disabled: !canReceive })}
      </div>
    </div>
  </section>`;
}

function filesPage() {
  const device = currentDevice();
  const active = state.transfers.filter(t => ACTIVE.includes(t.status)).length;
  return `<section class="page page--files" data-key="files">
    <div class="browser">${localPane(device)}${networkPane(device)}</div>
    <footer class="browser__foot">
      <span>Drag between the panes to copy, or drop from ${state.self.platform === 'darwin' ? 'Finder' : 'Explorer'} onto the network side. Originals are kept and existing files are never overwritten.</span>
      ${active ? button('goto-transfers', `${icon('swap')}${plural(active, 'transfer')} in progress`, { cls: 'button button--quiet button--small' }) : ''}
    </footer>
  </section>`;
}

// ── Transfers page ───────────────────────────────────────────────────────
const STATUS = {
  queued: ['Queued', ''],
  running: ['Transferring', 'is-live'],
  complete: ['Complete', 'is-ok'],
  failed: ['Failed', 'is-bad'],
  cancelled: ['Cancelled', ''],
};

function transferRow(t) {
  const [label, kind] = STATUS[t.status] || [t.status, ''];
  const outgoing = / to$/.test(t.direction);
  const total = Math.max(t.total, t.bytes, 1);
  const skipped = t.skippedCount
    ? `<details class="transfer__skipped"><summary>${plural(t.skippedCount, 'item')} skipped, not copied</summary><p>Links and special files inside folders are skipped. Originals remain unchanged.</p><ul>${(t.skipped || []).map(item => `<li>${esc(item.path)} — ${esc(item.reason)}</li>`).join('')}</ul></details>`
    : '';
  return `<article class="transfer is-${esc(t.status)}" data-key="${esc(t.id)}">
    <span class="tile-icon">${icon(outgoing ? 'arrowUp' : 'arrowDown')}</span>
    <div class="transfer__main">
      <div class="transfer__title"><h3>${esc(t.name)}</h3>${chip(t.status === 'complete' && t.skippedCount ? 'Complete with skips' : label, kind)}</div>
      <p>${esc(t.direction)} ${esc(t.device)}</p>
      <progress max="${total}" value="${t.status === 'complete' ? total : t.bytes}"></progress>
      <div class="transfer__meta"><span>${bytes(t.bytes)} of ${bytes(Math.max(t.total, t.bytes))} · ${plural(t.files, 'file')} verified${t.speed ? ' · ' + bytes(t.speed) + '/s' : ''}</span></div>
      ${t.error ? `<p class="transfer__error">${esc(t.error)}</p>` : ''}
      ${skipped}
    </div>
    ${ACTIVE.includes(t.status) ? button('cancel-transfer', 'Cancel', { cls: 'button button--small', attrs: `data-id="${esc(t.id)}"` }) : ''}
  </article>`;
}

function transfersPage() {
  const finished = state.transfers.some(t => !ACTIVE.includes(t.status));
  return `<section class="page" data-key="transfers">
    ${pageHead('Direct delivery', 'Transfers', 'Files travel straight between your computers and are checksum-verified on arrival.', finished ? button('clear-transfers', 'Clear finished', { cls: 'button button--quiet' }) : '')}
    ${
      state.transfers.length
        ? `<div class="transfer-list">${[...state.transfers].reverse().map(transferRow).join('')}</div>`
        : empty(
            'swap',
            'Nothing in transit',
            'Open a nearby computer in Files to send or receive. Progress shows up here.',
            button('goto-files', 'Open Files'),
          )
    }
  </section>`;
}

// ── Shared folders page ──────────────────────────────────────────────────
function sharedPage() {
  const rows = state.shares
    .map(
      s => `<div class="row share-row" data-key="${esc(s.id)}">
        <span class="tile-icon">${icon('folder')}</span>
        <div class="row__title"><strong>${esc(s.name)}</strong><span title="${esc(s.path)}">${esc(s.path)}</span></div>
        <label class="switch-label">
          <button class="ui-switch ${s.writable ? 'is-on' : ''}" role="switch" aria-checked="${s.writable}" data-action="toggle-write" data-id="${esc(s.id)}" aria-label="Allow uploads and moves into ${esc(s.name)}"><span class="ui-switch__thumb"></span></button>
          <span>${s.writable ? 'Read and write' : 'Read-only'}</span>
        </label>
        ${iconButton('reveal-share', 'external', 'Open this folder', { attrs: `data-id="${esc(s.id)}"` })}
        ${iconButton('remove-share', 'trash', `Stop sharing ${s.name}`, { attrs: `data-id="${esc(s.id)}"` })}
      </div>`,
    )
    .join('');
  return `<section class="page" data-key="shared">
    ${pageHead('On this computer', 'Shared folders', 'Paired computers can browse these folders. Everything else on this computer stays private.')}
    ${
      state.shares.length
        ? `<div class="row-list">${rows}</div><p class="hint">Folders start read-only. Turn on read and write only for folders you want paired computers to add to or move files out of.</p>`
        : empty(
            'folder',
            'Nothing shared yet',
            'Choose a folder your paired computers can browse.',
            button('add-share', icon('plus') + 'Share a folder', { cls: 'button button--primary' }),
          )
    }
  </section>`;
}

// ── Overlays: pairing and settings ───────────────────────────────────────
function pairingOverlay() {
  const pairings = [
    ...state.incoming.map(p => ({ ...p, incoming: true, device: p.name, approved: p.localApproved })),
    ...state.outgoing.map(p => ({ ...p, incoming: false })),
  ];
  if (!pairings.length) return '';
  return `<div class="backdrop backdrop--pairing">${pairings
    .map(
      p => `<section class="app-dialog pairing" role="alertdialog" aria-label="Pair with ${esc(p.device)}" data-key="${esc(p.id)}">
        <span class="pairing__icon">${icon('link')}</span>
        <h2>Pair with ${esc(p.device)}</h2>
        <p>Check that this exact code appears on both computers.</p>
        <div class="pair-code" aria-label="Pairing code">${String(p.code)
          .split(' ')
          .map(group => `<span>${esc(group)}</span>`)
          .join('')}</div>
        <p class="pairing__status">${p.approved ? '<span class="pulse"></span>Approved here. Waiting for the other computer…' : 'Approve on both computers only if the codes match.'}${p.error ? ' ' + esc(p.error) : ''}</p>
        <div class="app-dialog__actions">
          ${button('decline-pair', 'Cancel', { cls: 'button button--quiet', attrs: `data-id="${esc(p.id)}" data-incoming="${p.incoming}"` })}
          ${p.approved ? '' : button('approve-pair', icon('check') + 'Codes match', { cls: 'button button--primary', attrs: `data-id="${esc(p.id)}" data-incoming="${p.incoming}"` })}
        </div>
      </section>`,
    )
    .join('')}</div>`;
}

function settingsSection() {
  const online = new Set(state.devices.map(d => d.id));
  const n = state.network;
  const mac = state.self.platform === 'darwin';
  const heading = (eyebrow, title, description) =>
    `<div class="settings__heading"><div class="eyebrow">${eyebrow}</div><h3>${title}</h3><p>${description}</p></div>`;

  if (ui.settingsSection === 'trusted') {
    return `${heading('Pairing', 'Trusted computers', 'Pairing is remembered while a computer is offline. Forgetting one means you will need to pair again.')}
      ${
        state.trusted.length
          ? `<div class="row-list">${state.trusted.map(t => `<div class="row" data-key="${esc(t.id)}"><span class="tile-icon">${icon('laptop')}</span><div class="row__title"><strong>${esc(t.name)}</strong><span>Paired ${new Date(t.pairedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span></div>${online.has(t.id) ? chip('Online', 'is-ok') : chip('Offline')}${button('forget', 'Forget', { cls: 'button button--danger button--small', attrs: `data-id="${esc(t.id)}"` })}</div>`).join('')}</div>`
          : `<p class="settings__empty">No computers paired yet.</p>`
      }`;
  }
  if (ui.settingsSection === 'network') {
    return `${heading('Diagnostics', 'Network', 'Nearlink only talks to computers on the same local network as this one.')}
      <dl class="facts">
        <div><dt>Address</dt><dd>${n.addresses.length ? n.addresses.map(esc).join(', ') : 'No local network found'}</dd></div>
        <div><dt>Port</dt><dd>${esc(n.port)}</dd></div>
        <div><dt>Devices found</dt><dd>${esc(n.candidates)} discovered · ${state.devices.length} reachable</dd></div>
      </dl>
      ${n.failures.map(f => `<div class="notice notice--warn"><span class="notice__icon">${icon('alert')}</span><div><p>Found a device at ${esc(f.address)}, but could not connect: ${esc(f.message)}</p></div></div>`).join('')}
      <p class="hint">${mac ? 'If nothing appears, open System Settings → Privacy &amp; Security → Local Network and turn on Nearlink.' : 'If nothing appears, allow Nearlink through Windows Firewall on Private networks.'} Guest Wi-Fi often blocks discovery.</p>
      <div class="settings__actions">${button('network-settings', (mac ? 'Open Local Network settings' : 'Open network settings') + icon('external'))}${button('refresh', icon('refresh') + 'Scan again', { cls: 'button button--quiet' })}</div>`;
  }
  if (ui.settingsSection === 'about') {
    return `${heading('Nearlink ' + esc(state.self.version), 'Local by design', 'There is no account, no analytics and no cloud service.')}
      <ul class="plain-list">
        <li>${icon('wifi')}<span>Discovery uses your local network only. VPN and tunnel interfaces are ignored.</span></li>
        <li>${icon('shield')}<span>Every connection is encrypted, and each computer is recognised by its own certificate.</span></li>
        <li>${icon('check')}<span>Each file is checksum-verified before it is saved. Existing files are never overwritten.</span></li>
        <li>${icon('close')}<span>Closing Nearlink stops sharing and makes this computer disappear from the others.</span></li>
      </ul>
      <p class="hint">Settings and this computer’s identity are plain files on this computer. Keep identity.json private.</p>
      <div class="settings__actions">${button('open-data-folder', 'Open settings folder' + icon('external'))}</div>`;
  }
  const fp = state.self.fingerprint || '';
  return `${heading('Identity', 'This computer', 'This is how your computer appears to the others on your network.')}
    <form id="name-form" class="field-row">
      <label class="field"><span>Computer name</span><input id="device-name" maxlength="80" value="${esc(state.self.name)}" required autocomplete="off" spellcheck="false"></label>
      <button class="button button--primary" type="submit">Save name</button>
    </form>
    <dl class="facts">
      <div><dt>System</dt><dd>${esc(platformName(state.self.platform))}</dd></div>
      <div><dt>Fingerprint</dt><dd class="mono">${esc((fp.slice(0, 32).match(/.{4}/g) || []).join(' '))}…</dd></div>
    </dl>
    <p class="hint">The fingerprint identifies this computer’s certificate. Paired computers check it on every connection.</p>`;
}

function settingsOverlay() {
  if (!ui.settingsOpen) return '';
  const nav = [
    ['computer', 'laptop', 'This computer', state.self.name],
    ['trusted', 'shield', 'Trusted computers', plural(state.trusted.length, 'computer') + ' paired'],
    ['network', 'wifi', 'Network', state.network.addresses[0] || 'Not connected'],
    ['about', 'info', 'About', 'Version ' + state.self.version],
  ];
  return `<div class="backdrop" data-action="close-settings" data-self-only="true">
    <div class="settings" role="dialog" aria-modal="true" aria-label="Settings">
      <header class="settings__header">
        <div><div class="eyebrow">Nearlink</div><h2>Settings</h2></div>
        ${button('close-settings', icon('close'), { cls: 'settings__close', attrs: 'aria-label="Close settings"' })}
      </header>
      <nav class="settings__nav" data-active="${SETTINGS_SECTIONS.indexOf(ui.settingsSection)}">
        <span class="settings__nav-indicator"></span>
        ${nav.map(([id, iconName, title, sub]) => button('settings-section', `<span class="settings__nav-icon">${icon(iconName)}</span><span class="settings__nav-text"><strong>${title}</strong><span>${esc(sub)}</span></span>`, { cls: ui.settingsSection === id ? 'active' : '', attrs: `data-id="${id}"` })).join('')}
      </nav>
      <div class="settings__body" data-key="${ui.settingsSection}">${settingsSection()}</div>
    </div>
  </div>`;
}

// ── Render ───────────────────────────────────────────────────────────────
function render() {
  // Replacing rows mid-drag would cancel the drag.
  if (!state || drag.source || drag.external) return;
  renderChrome();
  const page = { devices: devicesPage, files: filesPage, transfers: transfersPage, shared: sharedPage }[ui.tab];
  morph($('main'), page());
  morph($('overlays'), settingsOverlay() + pairingOverlay());
}

// ── Browsing ─────────────────────────────────────────────────────────────
function loadPreferences(next) {
  if (preferencesLoaded) return;
  preferencesLoaded = true;
  for (const side of ['local', 'network']) {
    const p = next.browserPreferences?.[side];
    const valid =
      p &&
      ['grid', 'list', 'details'].includes(p.view) &&
      ['name', 'size', 'type', 'modified'].includes(p.sort) &&
      ['asc', 'desc'].includes(p.direction);
    if (valid) Object.assign(panes[side], p);
  }
}

function savePreferences() {
  return api.invoke('browser:preferences', panes);
}

async function browseLocal(id, choose = false) {
  const generation = ++localGeneration;
  ui.localLoading = true;
  render();
  try {
    const result = await api.invoke(choose ? 'local:choose' : 'local:browse', id);
    if (generation === localGeneration && result) {
      if (result.path !== ui.local?.path) panes.local.query = '';
      ui.local = result;
      picks.local.clear();
    }
  } catch (error) {
    toast(error.message);
  } finally {
    if (generation === localGeneration) {
      ui.localLoading = false;
      render();
    }
  }
}

async function browseRemote() {
  const location = `${ui.device}:${ui.share?.id}:${ui.path}`;
  if (location !== ui.remoteLocation) {
    panes.network.query = '';
    ui.remoteLocation = location;
  }
  const generation = ++remoteGeneration;
  ui.remoteLoading = true;
  picks.network.clear();
  render();
  try {
    const result = await api.invoke('remote:browse', ui.device, ui.share?.id, ui.path);
    if (generation === remoteGeneration) ui.remote = result;
  } catch (error) {
    if (generation === remoteGeneration) {
      ui.remote = null;
      toast(error.message);
    }
  } finally {
    if (generation === remoteGeneration) {
      ui.remoteLoading = false;
      render();
    }
  }
}

function resetRemote() {
  ++remoteGeneration;
  ui.remoteLoading = false;
  ui.device = null;
  ui.share = null;
  ui.path = '';
  ui.remote = null;
  picks.network.clear();
}

async function openTab(tab) {
  ui.tab = tab;
  render();
  if (tab === 'files' && !ui.local && !ui.localLoading) await browseLocal();
}

async function copyBetween(direction, move) {
  const id = await api.invoke('transfer:between', {
    device: ui.device,
    share: ui.share.id,
    relative: ui.path,
    direction,
    move,
    destination: ui.local?.id,
    items: direction === 'send' ? [...picks.local] : [...picks.network].map(remotePath),
  });
  if (id) {
    picks[direction === 'send' ? 'local' : 'network'].clear();
    toast(move ? 'Move queued.' : 'Copy queued.', 'success');
    render();
  }
}

// ── Actions ──────────────────────────────────────────────────────────────
const actions = {
  refresh: async () => {
    state = await api.invoke('devices:refresh');
    render();
  },
  'open-settings': () => {
    ui.settingsOpen = true;
    render();
  },
  'close-settings': () => {
    ui.settingsOpen = false;
    render();
  },
  'settings-section': b => {
    ui.settingsSection = b.dataset.id;
    render();
  },
  'goto-transfers': () => openTab('transfers'),
  'goto-files': () => openTab('files'),

  // Devices and pairing
  pair: b => api.invoke('pair:start', b.dataset.id),
  'approve-pair': b => api.invoke('pair:approve', b.dataset.id, b.dataset.incoming === 'true'),
  'decline-pair': b => api.invoke('pair:reject', b.dataset.id, b.dataset.incoming === 'true'),
  forget: b => api.invoke('trust:remove', b.dataset.id),
  'open-device': async b => {
    ui.device = b.dataset.id;
    ui.tab = 'files';
    ui.share = null;
    ui.path = '';
    ui.remote = null;
    const device = currentDevice();
    await Promise.all([device?.paired ? browseRemote() : render(), ui.local ? null : browseLocal()]);
  },

  // Shared folders
  'add-share': async () => {
    await api.invoke('shares:add');
  },
  'remove-share': b => api.invoke('shares:remove', b.dataset.id),
  'reveal-share': b => api.invoke('shares:reveal', b.dataset.id),
  'toggle-write': b => api.invoke('shares:write', b.dataset.id, b.getAttribute('aria-checked') !== 'true'),

  // Local pane
  'local-choose': () => browseLocal(undefined, true),
  'local-home': () => browseLocal(),
  'local-up': () => browseLocal(ui.local.parent),
  'local-refresh': () => browseLocal(ui.local?.id),

  // Network pane
  'network-root': () => {
    resetRemote();
    render();
  },
  'open-share': async b => {
    ui.share = ui.remote.shares.find(s => s.id === b.dataset.id);
    ui.path = '';
    await browseRemote();
  },
  'remote-up': async () => {
    if (!ui.share) {
      resetRemote();
      render();
      return;
    }
    if (!ui.path) ui.share = null;
    else ui.path = ui.path.split('/').slice(0, -1).join('/');
    await browseRemote();
  },
  'remote-refresh': async () => {
    if (ui.device) await browseRemote();
    else await actions.refresh();
  },
  'open-entry': async b => {
    const entry = entriesOf(b.dataset.side)[Number(b.dataset.index)];
    if (!entry) return;
    if (b.dataset.side === 'local') await browseLocal(entry.id);
    else {
      ui.path = remotePath(entry.name);
      await browseRemote();
    }
  },

  // View options
  'view-mode': async b => {
    panes[b.dataset.side].view = b.dataset.mode;
    render();
    await savePreferences();
  },
  'sort-direction': async b => {
    const p = panes[b.dataset.side];
    p.direction = p.direction === 'asc' ? 'desc' : 'asc';
    render();
    await savePreferences();
  },
  'clear-search': b => {
    panes[b.dataset.side].query = '';
    render();
  },

  // Transfers
  'copy-send': () => copyBetween('send', false),
  'move-send': () => copyBetween('send', true),
  'copy-receive': () => copyBetween('receive', false),
  'move-receive': () => copyBetween('receive', true),
  'send-files': async () => {
    if (await api.invoke('transfer:send', ui.device, ui.share.id, ui.path, 'files')) toast('Copy queued.', 'success');
  },
  'send-folder': async () => {
    if (await api.invoke('transfer:send', ui.device, ui.share.id, ui.path, 'folder')) toast('Copy queued.', 'success');
  },
  'cancel-transfer': b => api.invoke('transfer:cancel', b.dataset.id),
  'clear-transfers': () => api.invoke('transfer:clear'),

  // Settings
  'network-settings': () => api.invoke('network:settings'),
  'open-data-folder': () => api.invoke('settings:open'),
};

document.addEventListener('click', async event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) return openTab(tab.dataset.tab);

  const target = event.target.closest('[data-action]');
  if (target) {
    // A backdrop closes its dialog only when the click lands on the backdrop itself.
    if (target.dataset.selfOnly && event.target !== target) return;
    if (busy.has(target) || target.disabled) return;
    const run = actions[target.dataset.action];
    if (!run) return;
    busy.add(target);
    try {
      await run(target);
    } catch (error) {
      toast(error.message);
    } finally {
      busy.delete(target);
    }
    return;
  }

  // Clicking anywhere else on a file row toggles its selection.
  const row = event.target.closest('[data-drag-side]');
  if (row && !event.target.closest('input, button, label')) {
    const side = row.dataset.dragSide;
    const entry = entriesOf(side)[Number(row.dataset.dragIndex)];
    if (!entry) return;
    const key = keyOf(side, entry);
    if (picks[side].has(key)) picks[side].delete(key);
    else picks[side].add(key);
    render();
  }
});

document.addEventListener('change', async event => {
  const t = event.target;
  try {
    if (t.dataset.sort) {
      panes[t.dataset.sort].sort = t.value;
      render();
      await savePreferences();
    } else if (t.dataset.pickSide) {
      const side = t.dataset.pickSide;
      const entry = entriesOf(side)[Number(t.dataset.index)];
      if (!entry) return;
      if (t.checked) picks[side].add(keyOf(side, entry));
      else picks[side].delete(keyOf(side, entry));
      render();
    } else if (t.dataset.selectAll) {
      const side = t.dataset.selectAll;
      picks[side].clear();
      if (t.checked) FileView.visible(entriesOf(side), panes[side]).forEach(e => picks[side].add(keyOf(side, e)));
      render();
    } else if (t.id === 'self-name') {
      await saveName(t.value);
    }
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('input', event => {
  const side = event.target.dataset.search;
  if (!side) return;
  panes[side].query = event.target.value;
  // A selection never includes rows the search has hidden.
  const visible = new Set(FileView.visible(entriesOf(side), panes[side]).map(e => keyOf(side, e)));
  for (const key of picks[side]) if (!visible.has(key)) picks[side].delete(key);
  render();
});

async function saveName(value) {
  const name = value.trim();
  if (!name) {
    $('self-name').value = state.self.name;
    return;
  }
  if (name === state.self.name) return;
  await api.invoke('settings:name', name);
  toast('Computer name updated.', 'success');
}

document.addEventListener('submit', async event => {
  if (event.target.id !== 'name-form') return;
  event.preventDefault();
  try {
    await saveName($('device-name').value);
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && ui.settingsOpen) {
    ui.settingsOpen = false;
    render();
  } else if (event.key === 'Enter' && event.target.id === 'self-name') {
    event.target.blur();
  } else if ((event.metaKey || event.ctrlKey) && /^[1-4]$/.test(event.key) && !ui.settingsOpen) {
    event.preventDefault();
    openTab(TABS[Number(event.key) - 1]);
  }
});

// ── Drag and drop ────────────────────────────────────────────────────────
// Drag payloads stay inside this window; drops from Finder or Explorer are resolved from native files.
function clearDrop() {
  for (const el of document.querySelectorAll('.drop-ready, .drop-blocked')) {
    el.classList.remove('drop-ready', 'drop-blocked');
    delete el.dataset.dropMessage;
  }
}

function dropProblem(side) {
  if (drag.source?.side === side) return 'Drop into the other pane to copy.';
  if (side === 'local') {
    if (!drag.source)
      return `Drop ${state.self.platform === 'darwin' ? 'Finder' : 'Explorer'} items onto the network side.`;
    if (!ui.local || ui.localLoading) return 'Open a local destination folder first.';
    if (!state.devices.some(d => d.id === drag.source.device && d.paired)) return 'The source computer is offline.';
  } else {
    if (!state.devices.some(d => d.id === ui.device && d.paired)) return 'Open a paired, online computer first.';
    if (!ui.share || ui.remoteLoading) return 'Open a shared destination folder first.';
    if (!ui.share.writable) return 'This shared folder is read-only.';
  }
  return '';
}

function endDrag() {
  drag.source = null;
  drag.external = false;
  clearTimeout(drag.timer);
  clearDrop();
}

document.addEventListener('dragstart', event => {
  const row = event.target.closest?.('[data-drag-side]');
  if (!row || event.target.matches?.('input')) return event.preventDefault();
  const side = row.dataset.dragSide;
  const entry = entriesOf(side)[Number(row.dataset.dragIndex)];
  if (!entry || ui.localLoading || ui.remoteLoading) return event.preventDefault();
  const key = keyOf(side, entry);
  const items = picks[side].has(key) ? [...picks[side]] : [key];
  drag.source = {
    side,
    device: ui.device,
    share: ui.share?.id,
    items: side === 'local' ? items : items.map(remotePath),
  };
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-nearlink-items', 'copy');
  event.dataTransfer.setData('text/plain', plural(items.length, 'Nearlink item'));
});

function dragOver(event) {
  const hasFiles = Array.from(event.dataTransfer.types).includes('Files');
  if (!drag.source && hasFiles) {
    drag.external = true;
    clearTimeout(drag.timer);
    drag.timer = setTimeout(() => {
      endDrag();
      render();
    }, 1500);
  }
  event.preventDefault(); // Never navigate the window to a dropped file.
  const pane = event.target.closest?.('[data-drop-side]');
  clearDrop();
  if (!pane || (!drag.source && !hasFiles)) {
    event.dataTransfer.dropEffect = 'none';
    return;
  }
  const problem = dropProblem(pane.dataset.dropSide);
  pane.classList.add(problem ? 'drop-blocked' : 'drop-ready');
  pane.dataset.dropMessage = problem || 'Release to copy into this folder';
  event.dataTransfer.dropEffect = problem ? 'none' : 'copy';
}
document.addEventListener('dragenter', dragOver);
document.addEventListener('dragover', dragOver);
document.addEventListener('dragleave', event => {
  const pane = event.target.closest?.('[data-drop-side]');
  if (pane && !pane.contains(event.relatedTarget)) clearDrop();
});
document.addEventListener('dragend', () => {
  endDrag();
  render();
});
document.addEventListener('drop', async event => {
  event.preventDefault();
  const pane = event.target.closest?.('[data-drop-side]');
  const source = drag.source;
  try {
    if (!pane) return;
    const side = pane.dataset.dropSide;
    const problem = dropProblem(side);
    if (problem) throw new Error(problem);
    let id;
    if (source) {
      id = await api.invoke('transfer:between', {
        device: side === 'local' ? source.device : ui.device,
        share: side === 'local' ? source.share : ui.share.id,
        relative: ui.path,
        direction: side === 'local' ? 'receive' : 'send',
        destination: ui.local?.id,
        items: source.items,
        move: false,
      });
    } else {
      id = await api.dropFiles(Array.from(event.dataTransfer.files), {
        device: ui.device,
        share: ui.share.id,
        relative: ui.path,
      });
    }
    if (id) toast('Copy queued.', 'success');
  } catch (error) {
    toast(error.message);
  } finally {
    endDrag();
    render();
  }
});

// ── Start ────────────────────────────────────────────────────────────────
function receive(next) {
  const justFinished =
    state &&
    next.transfers.some(
      t => t.status === 'complete' && state.transfers.find(old => old.id === t.id)?.status === 'running',
    );
  loadPreferences(next);
  state = next;
  render();
  if (justFinished && ui.tab === 'files') {
    if (ui.local) browseLocal(ui.local.id);
    if (ui.device && ui.share) browseRemote();
  }
}

document.body.classList.add('platform-' + api.platform);
Icons.hydrate(document);
api.onState(receive);
api
  .invoke('state:get')
  .then(receive)
  .catch(error => toast(error.message));
