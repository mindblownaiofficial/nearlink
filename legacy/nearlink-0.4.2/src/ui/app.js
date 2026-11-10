const api = window.nearlink;
let state, page = 'overview', selectedDevice = null, currentShare = null, currentPath = '', remote = null, loading = false, browseGeneration = 0;
const selected = new Set();
const localSelected = new Set();
let dragSource = null, externalDrag = false;
let dragRefreshTimer;
let localFolder = null, localLoading = false, localGeneration = 0;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = n => { if (!n) return '0 B'; const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024))); return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][i]}`; };
const deviceIcon = p => p === 'darwin' ? '▱' : '▥';
const button = (action, text, attrs = '', cls = '') => `<button class="${cls}" data-action="${action}" ${attrs}>${text}</button>`;
function toast(message) { $('toast').textContent = message.replace(/^Error invoking remote method '[^']+': Error: /, ''); $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 7000); }
function title(kicker, name, description, action = '') { return `<div class="eyebrow">${kicker}</div><div class="title-row"><div><h1>${name}</h1><p class="subtitle">${description}</p></div>${action}</div>`; }
function empty(icon, heading, description, action = '') { return `<div class="empty"><span class="empty-icon">${icon}</span><h3>${heading}</h3><p>${description}</p>${action}</div>`; }
function shares() {
  return state.shares.length ? state.shares.map(s => `<div class="share-row"><div class="tile-icon">▱</div><div class="share-info"><h3>${esc(s.name)}</h3><small title="${esc(s.path)}">${esc(s.path)}</small></div><label><input type="checkbox" data-write="${esc(s.id)}" ${s.writable ? 'checked' : ''}> Allow uploads & moves</label>${button('remove-share', '×', `data-id="${esc(s.id)}" aria-label="Stop sharing ${esc(s.name)}"`, 'icon-button')}</div>`).join('') : empty('▱', 'Make a little room for sharing', 'Choose a folder your paired computers can browse. Everything else stays private.', button('add-share', '+ Share a folder', '', 'primary'));
}
function networkHelp() {
  const n = state.network;
  if (!n) return '';
  return `<div class="notice"><h3>Connection help</h3><p>${n.addresses.length ? 'This computer: ' + n.addresses.map(esc).join(', ') : 'No supported local IPv4 network found. Connect to your home or office network.'}</p>${n.failures.map(f => `<p>Found a device at ${esc(f.address)}, but could not connect: ${esc(f.message)}</p>`).join('')}<p>${state.self.platform === 'darwin' ? 'On this Mac, open System Settings → Privacy & Security → Local Network and enable Nearlink. Then return here and refresh.' : 'Allow Nearlink through Windows Firewall on Private networks. Both computers must be on the same local network.'}</p>${button('network-settings', state.self.platform === 'darwin' ? 'Open Local Network settings ↗' : 'Open network settings ↗', '', 'text-button')}${button('refresh', 'Retry discovery', '', 'text-button')}</div>`;
}
function overview() {
  return title('CLOSE BY. CONNECTED.', 'Your files, within reach.', 'A private workspace for the computers on your network.', button('refresh', '↻ Refresh', '', 'secondary')) +
    (!state.devices.length ? networkHelp() : '') +
    `<div class="hero"><div><div class="eyebrow">LESS FRICTION. MORE FLOW.</div><h2>Different computers.<br>One easy connection.</h2><p>Pair once. Browse shared folders. Move your files directly from one computer to another.</p></div><div class="connection-art" aria-hidden="true"><div class="computer-art">▱<small>MAC</small></div><span class="connection-line">⇄</span><div class="computer-art">▥<small>WINDOWS</small></div></div></div>` +
    `<div class="section-title"><h2>Nearby computers <span>(${state.devices.length})</span></h2><span>Only online devices appear here</span></div>` +
    (state.devices.length ? `<div class="grid">${state.devices.map(d => `<article class="card"><div class="card-head"><div class="tile-icon">${deviceIcon(d.platform)}</div><div><h3>${esc(d.name)}</h3><small>${d.platform === 'darwin' ? 'macOS' : d.platform === 'win32' ? 'Windows' : esc(d.platform)} · ${esc(d.host)}</small></div></div><div class="card-bottom"><span class="badge"><span class="status-dot"></span> ${d.paired ? 'Paired & online' : 'Ready to pair'}</span>${button(d.paired ? 'open-device' : 'pair', d.paired ? 'Browse files →' : 'Pair device →', `data-id="${esc(d.id)}"`, 'text-button')}</div></article>`).join('')}</div>` : empty('⌁', 'Waiting for your other computer', 'Open Nearlink on your Mac or Windows PC connected to the same network. It will appear here automatically.')) +
    `<div class="section-title"><h2>Your shared folders</h2>${state.shares.length ? button('add-share', '+ Add folder', '', 'text-button') : ''}</div>${shares()}<p class="hint">Shared folders start as read-only. Enable uploads & moves only for folders you want your paired computers to change.</p>`;
}
const paneOptions = { local: FileView.defaults(), network: FileView.defaults() };
let preferencesLoaded = false, remoteLocation = '';
function loadPreferences(next) {
  if (preferencesLoaded) return; preferencesLoaded = true;
  for (const side of ['local','network']) {
    const p = next.browserPreferences?.[side];
    if (p && ['grid','list','details'].includes(p.view) && ['name','size','type','modified'].includes(p.sort) && ['asc','desc'].includes(p.direction)) Object.assign(paneOptions[side], p);
  }
}
async function savePreferences() { await api.invoke('browser:preferences', paneOptions); }
function viewControls(side, enabled = true) {
  const p = paneOptions[side];
  return `<div class="view-controls"><div class="pane-search"><span aria-hidden="true">⌕</span><input type="search" data-search="${side}" aria-label="Search ${side} folder" placeholder="Search this folder…" value="${esc(p.query)}" ${enabled ? '' : 'disabled'} autocomplete="off">${p.query ? button('clear-search','×',`data-side="${side}" aria-label="Clear ${side} search"`,'icon-button') : ''}</div><div class="view-options"><div class="view-switch" role="group" aria-label="${side} view">${[['list','☰','List'],['grid','▦','Grid'],['details','▤','Details']].map(([mode,icon,label]) => button('view-mode',icon,`data-side="${side}" data-mode="${mode}" aria-label="${label} view for ${side}" title="${label} view" aria-pressed="${p.view === mode}"`,p.view === mode ? 'active' : '')).join('')}</div><label>Sort <select data-sort="${side}" aria-label="Sort ${side} folder">${[['name','Name'],['size','Size'],['type','Type'],['modified','Date modified']].map(([value,label])=>`<option value="${value}" ${p.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${button('sort-direction',p.direction === 'asc' ? '↑' : '↓',`data-side="${side}" aria-label="${p.direction === 'asc' ? 'Ascending' : 'Descending'} order for ${side}" title="Reverse sort order"`,'sort-direction')}</div></div>`;
}
function paneSummary(entries, side, picks) {
  const count = FileView.visible(entries, paneOptions[side]).length;
  return `${picks.size} selected · ${paneOptions[side].query ? `${count} of ${entries.length}` : entries.length} items`;
}
function fileRows(entries, side, picks) {
  const options = paneOptions[side], shown = FileView.visible(entries, options);
  if (!shown.length) return `<div class="pane-empty">${options.query ? `No matches for “${esc(options.query)}”.<br><small>Search checks names in this folder only.</small>${button('clear-search','Clear search',`data-side="${side}"`,'text-button')}` : 'This folder is empty.'}</div>`;
  const key = e => side === 'local' ? e.id : e.name;
  const checkbox = e => `<input type="checkbox" data-pick-side="${side}" data-index="${e.index}" aria-label="Select ${side} ${esc(e.name)}" ${picks.has(key(e)) ? 'checked' : ''}>`;
  const all = `<input type="checkbox" data-select-all="${side}" aria-label="Select all ${side} items" ${shown.every(e => picks.has(key(e))) ? 'checked' : ''}>`;
  const name = e => e.directory ? button(side === 'local' ? 'local-folder' : 'open-folder', `<span class="file-symbol">▱</span><span>${esc(e.name)}</span>`, `data-index="${e.index}" title="Open ${esc(e.name)}"`, 'file-name') : `<span class="file-name"><span class="file-symbol">▤</span><span>${esc(e.name)}</span></span>`;
  if (options.view === 'grid') return `<div class="grid-select"><label>${all} Select all visible</label><span>${shown.length} items</span></div><div class="file-grid">${shown.map(e => `<article draggable="true" data-drag-side="${side}" data-drag-index="${e.index}" class="file-tile ${picks.has(key(e)) ? 'selected' : ''}"><label class="tile-pick">${checkbox(e)}</label>${name(e)}<small>${e.directory ? 'Folder' : bytes(e.size)}</small></article>`).join('')}</div>`;
  const details = options.view === 'details';
  return `<table class="files browser-files ${details ? 'details-files' : ''}"><thead><tr><th>${all}</th><th>NAME</th><th>SIZE</th>${details ? '<th>TYPE</th><th>MODIFIED</th>' : ''}</tr></thead><tbody>${shown.map(e => `<tr draggable="true" data-drag-side="${side}" data-drag-index="${e.index}" class="${picks.has(key(e)) ? 'selected' : ''}"><td>${checkbox(e)}</td><td>${name(e)}</td><td>${e.directory ? '—' : bytes(e.size)}</td>${details ? `<td>${esc(FileView.type(e))}</td><td>${new Date(e.modified).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}</td>` : ''}</tr>`).join('')}</tbody></table>`;
}

function explorer() {
  const d = state.devices.find(d => d.id === selectedDevice);
  const canSend = !!(d?.paired && currentShare?.writable && !loading && !localLoading && localSelected.size);
  const canReceive = !!(d?.paired && currentShare && !loading && selected.size && localFolder && !localLoading);
  const localFilesOnly = !!localFolder && localFolder.entries.filter(e => localSelected.has(e.id)).every(e => !e.directory);
  const remoteFilesOnly = !!remote?.entries && remote.entries.filter(e => selected.has(e.name)).every(e => !e.directory);
  const localPane = `<section class="browser-pane" data-drop-side="local" aria-label="Local files"><div class="pane-heading"><div><span class="eyebrow">THIS COMPUTER</span><h2>${esc(state.self.name)}</h2></div>${button('local-choose', 'Choose folder…', '', 'text-button')}</div><div class="pane-path">${button('local-up', '↑', localFolder?.parent && !localLoading ? 'aria-label="Local parent folder"' : 'disabled aria-label="Local parent folder"')}${button('local-home', '⌂', 'aria-label="Local home folder"')}<span title="${esc(localFolder?.path || '')}">${esc(localFolder?.path || 'Home')}</span>${button('local-refresh', '↻', 'aria-label="Refresh local folder"')}</div>${viewControls('local', !!localFolder && !localLoading)}<div class="pane-list" data-scrollkey="local">${localLoading ? '<div class="pane-empty">Opening folder…</div>' : localFolder ? fileRows(localFolder.entries, 'local', localSelected) : empty('▱', 'Browse this computer', 'Choose any folder or connected drive.', button('local-choose', 'Choose folder…'))}</div><div class="pane-summary">${paneSummary(localFolder?.entries || [], 'local', localSelected)}</div><div class="pane-actions">${button('copy-send', 'Copy to network →', canSend ? '' : 'disabled', 'primary')}${button('move-send', 'Move →', canSend && localFilesOnly ? '' : 'disabled')}<small>${currentShare ? currentShare.writable ? `To: ${esc(currentShare.name)}${currentPath ? '/' + esc(currentPath) : ''}` : 'Remote folder is read-only' : 'Open a shared folder as the destination'}</small></div></section>`;
  let content, pathLabel = 'Network computers';
  if (!selectedDevice) content = state.devices.length ? `<div class="network-folders">${state.devices.map(device => `<button class="network-folder" data-action="open-device" data-id="${esc(device.id)}"><span class="tile-icon">${deviceIcon(device.platform)}</span><span><strong>${esc(device.name)}</strong><small>${device.paired ? 'Browse shared folders' : 'Pair to browse'}</small></span><span>→</span></button>`).join('')}</div>` : empty('⌁', 'No computers online', 'Open Nearlink on another computer connected to your local network.');
  else if (!d) content = empty('⌁', 'Computer disconnected', 'This computer is no longer reachable. Its files will be available when it reconnects.', button('network-root', 'All computers'));
  else if (!d.paired) content = empty('⇄', 'Pair these computers first', 'Compare and approve the matching code on both computers.', button('pair', 'Pair device', `data-id="${esc(d.id)}"`, 'primary'));
  else if (loading) content = '<div class="pane-empty">Opening shared folders…</div>';
  else if (!remote) content = empty('↻', 'Ready to browse', 'Refresh to load this computer’s shared folders.', button('browse-refresh', 'Refresh'));
  else if (!currentShare) content = remote.shares?.length ? `<div class="network-folders">${remote.shares.map(s => `<article class="card share-card"><div class="tile-icon">▱</div><div><h3>${esc(s.name)}</h3><small>${s.writable ? 'Read & write' : 'Read-only'}</small></div>${button('open-share', 'Open folder →', `data-id="${esc(s.id)}"`, 'text-button')}</article>`).join('')}</div>` : empty('▱', 'No folders shared yet', 'On this computer, use Overview → Share a folder. Share a parent folder or drive to browse its subfolders here.');
  else content = fileRows(remote.entries || [], 'network', selected);
  if (d) pathLabel = d.name + (currentShare ? ' / ' + currentShare.name + (currentPath ? ' / ' + currentPath.split('/').join(' / ') : '') : ' / Shared folders');
  const remotePane = `<section class="browser-pane" data-drop-side="network" aria-label="Network files"><div class="pane-heading"><div><span class="eyebrow">LOCAL NETWORK</span><h2>${d ? esc(d.name) : 'Your computers'}</h2></div>${button('network-root', 'All computers', '', 'text-button')}</div><div class="pane-path">${button('up', '↑', selectedDevice ? 'aria-label="Network parent folder"' : 'disabled aria-label="Network parent folder"')}<span title="${esc(pathLabel)}">${esc(pathLabel)}</span>${button('browse-refresh', '↻', 'aria-label="Refresh network folder"')}</div>${viewControls('network', !!currentShare && !loading)}<div class="pane-list" data-scrollkey="network">${content}</div><div class="pane-summary">${paneSummary(remote?.entries || [], 'network', selected)}${d?.paired ? ' · Paired' : ''}</div><div class="pane-actions">${button('send', 'Add files…', d?.paired && currentShare?.writable && !loading ? '' : 'disabled')}${button('send-folder', 'Add folder…', d?.paired && currentShare?.writable && !loading ? '' : 'disabled')}${button('copy-receive', '← Copy to this computer', canReceive ? '' : 'disabled', 'primary')}${button('move-receive', '← Move', canReceive && currentShare.writable && remoteFilesOnly ? '' : 'disabled')}<small>To: ${esc(localFolder?.path || 'Choose a local folder')}</small></div></section>`;
  const active = state.transfers.filter(t => ['queued','running'].includes(t.status));
  return title('BROWSE & TRANSFER', 'File browser', 'Drag files or folders between panes to copy. Drop from Finder or Explorer into the network pane.', button('transfers', `Transfers${active.length ? ' (' + active.length + ')' : ''}`, '', 'secondary')) + `<div class="dual-browser">${localPane}${remotePane}</div><p class="hint">Drops copy into the open destination folder and keep the originals. Move removes verified originals and currently supports individual files. Existing files are never overwritten.</p>${active.length ? `<div class="browser-activity">⇄ ${active.length} transfer${active.length === 1 ? '' : 's'} in progress ${button('transfers','View progress →','','text-button')}</div>` : ''}`;
}
async function browseLocal(id, choose = false) {
  const generation = ++localGeneration; localLoading = true; render();
  try {
    const result = await api.invoke(choose ? 'local:choose' : 'local:browse', id);
    if (generation === localGeneration && result) { if (result.path !== localFolder?.path) paneOptions.local.query = ''; localFolder = result; localSelected.clear(); }
  } catch (error) { toast(error.message); }
  finally { if (generation === localGeneration) { localLoading = false; render(); } }
}
async function copyBetween(direction, move) {
  const id = await api.invoke('transfer:between', { device: selectedDevice, share: currentShare.id, relative: currentPath, direction, move, destination: localFolder?.id,
    items: direction === 'send' ? [...localSelected] : [...selected].map(name => currentPath ? currentPath + '/' + name : name) });
  if (id) { toast(move ? 'Move queued. See Transfers for progress.' : 'Copy queued. See Transfers for progress.'); render(); }
}

function skippedNotice(t) {
  if (!t.skippedCount) return '';
  return `<details class="transfer-warning"><summary>${t.skippedCount} item${t.skippedCount === 1 ? '' : 's'} skipped — not copied</summary><p>Links and special files inside folders are skipped. Their targets are not copied. Originals remain unchanged.</p><ul>${(t.skipped || []).map(item => `<li>${esc(item.path)} — ${esc(item.reason)}</li>`).join('')}</ul>${t.skippedCount > (t.skipped || []).length ? '<p>Showing the first 100 skipped items.</p>' : ''}</details>`;
}
function transferView() {
  return title('DIRECT DELIVERY', 'Your transfers', 'Files travel between your computers. No stops in the cloud.') + (state.transfers.length ? [...state.transfers].reverse().map(t => `<div class="transfer-row" data-transfer-id="${esc(t.id)}"><div class="transfer-head"><h3>${esc(t.name)}</h3><span class="badge ${t.status === 'complete' ? '' : 'neutral'}">${t.status === 'complete' && t.skippedCount ? 'complete with skips' : esc(t.status)}</span></div><p>${esc(t.direction)} ${esc(t.device)}</p><progress max="${Math.max(t.total, t.bytes, 1)}" value="${t.bytes}"></progress><div class="transfer-meta"><span>${bytes(t.bytes)} / ${bytes(Math.max(t.total, t.bytes))} · ${t.files} files verified${t.speed ? ' · ' + bytes(t.speed) + '/s' : ''}</span>${['running', 'queued'].includes(t.status) ? button('cancel-transfer', 'Cancel', `data-id="${esc(t.id)}"`, 'text-button') : ''}</div>${t.error ? `<p class="error">${esc(t.error)}</p>` : ''}${skippedNotice(t)}</div>`).join('') : empty('⇄', 'Nothing in transit', 'Open a nearby computer to send or receive files. Your transfer progress will appear here.'));
}
function settings() {
  return title('MAKE YOURSELF AT HOME', 'Settings', 'A few simple controls. Everything stays on this computer.') + networkHelp() + `<div class="card settings-card"><h2>This computer</h2><p>This is how your computer appears to nearby devices.</p><form id="name-form" class="field"><input id="device-name" aria-label="Computer name" maxlength="80" value="${esc(state.self.name)}" required><button class="primary" type="submit">Save name</button></form></div><div class="card settings-card"><h2>Trusted computers</h2><p>Pairing is remembered when a computer goes offline. Only reachable computers appear in your device list.</p>${state.trusted.length ? state.trusted.map(t => `<div class="trust-row"><span>${esc(t.name)}</span>${button('forget', 'Forget device', `data-id="${esc(t.id)}"`, 'text-button danger')}</div>`).join('') : '<p>No computers paired yet.</p>'}</div><div class="card settings-card"><h2>Local by design</h2><p>Discovery uses your local network. Transfers use encrypted connections and trusted device certificates. Closing Nearlink stops sharing and makes this computer disappear.</p><p>Settings and device identity are stored in local files. There is no database, account, analytics, or cloud service.</p>${button('open-settings', 'Open settings folder ↗', '', 'text-button')}<p class="hint">Keep identity.json private. On Windows, allow Nearlink through the firewall on Private networks only. Guest Wi-Fi may block device discovery.</p></div>${state.warnings.map(w => `<div class="notice">${esc(w)}</div>`).join('')}`;
}
// Keep live controls attached while progress changes: replacing a pressed button loses its click.
const renderedHTML = new WeakMap();
function setHTML(element, html) {
  if (renderedHTML.get(element) === html) return;
  element.innerHTML = html; renderedHTML.set(element, html);
}
function renderNavigation(count) {
  if (!$('navigation').children.length) {
    $('navigation').innerHTML = [['overview','▦','Overview'],['device','▱','File browser'],['transfers','⇄','Transfers'],['settings','⚙','Settings']]
      .map(([id, icon, label]) => button(id, `<span class="nav-icon">${icon}</span>${label}${id === 'transfers' ? '<span class="nav-count" hidden></span>' : ''}`, '', 'nav-button')).join('');
  }
  for (const node of $('navigation').children) node.classList.toggle('active', node.dataset.action === page);
  const badge = $('navigation').querySelector('.nav-count');
  badge.hidden = !count; badge.textContent = count || '';
}
function renderTransfers() {
  if (!$('main').querySelector('[data-transfer-list]')) {
    $('main').innerHTML = title('DIRECT DELIVERY', 'Your transfers', 'Files travel between your computers. No stops in the cloud.') + '<div data-transfer-list></div>';
    renderedHTML.delete($('main'));
  }
  const list = $('main').querySelector('[data-transfer-list]');
  const template = document.createElement('template');
  template.innerHTML = transferView();
  const incoming = [...template.content.querySelectorAll('[data-transfer-id]')];
  if (!incoming.length) { setHTML(list, empty('⇄', 'Nothing in transit', 'Open a nearby computer to send or receive files. Your transfer progress will appear here.')); return; }
  for (const child of [...list.children]) if (!child.dataset.transferId || !incoming.some(row => row.dataset.transferId === child.dataset.transferId)) child.remove();
  let previous = null;
  for (const fresh of incoming) {
    let row = [...list.children].find(node => node.dataset.transferId === fresh.dataset.transferId);
    if (!row) row = fresh;
    else {
      // Numeric/status fields update in place. Cancel remains the same clickable node.
      for (const selector of ['.badge', 'progress', '.transfer-meta > span', '.error']) {
        const old = row.querySelector(selector), next = fresh.querySelector(selector);
        if (old && next) {
          if (selector === 'progress') { old.max = next.max; old.value = next.value; }
          else { old.textContent = next.textContent; old.className = next.className; }
        } else if (next) row.append(next); else old?.remove();
      }
      const warning = row.querySelector('.transfer-warning'), nextWarning = fresh.querySelector('.transfer-warning');
      if (warning && nextWarning) setHTML(warning, nextWarning.innerHTML);
      else if (nextWarning) row.append(nextWarning);
      else warning?.remove();
      if (!fresh.querySelector('[data-action="cancel-transfer"]')) row.querySelector('[data-action="cancel-transfer"]')?.remove();
    }
    const expected = previous ? previous.nextElementSibling : list.firstElementChild;
    if (expected !== row) list.insertBefore(row, expected);
    previous = row;
  }
  renderedHTML.delete(list);
}
function render() {
  if (!state || dragSource || externalDrag) return;
  const dark = state.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-toggle').setAttribute('aria-pressed', String(dark));
  $('theme-toggle').textContent = dark ? '☀ Light mode' : '☾ Dark mode';
  $('theme-toggle').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  const count = state.transfers.filter(t => ['queued', 'running'].includes(t.status)).length;
  renderNavigation(count);
  setHTML($('device-list'), state.devices.length ? state.devices.map(d => button('open-device', `<span class="device-icon">${deviceIcon(d.platform)}</span><span>${esc(d.name)}<small>${d.paired ? 'Paired device' : 'Not paired yet'}</small></span><span class="status-dot"></span>`, `data-id="${esc(d.id)}"`, `device-button ${page === 'device' && selectedDevice === d.id ? 'active' : ''}`)).join('') : '<p class="sidebar-empty">No other computers online.<br>Listening on your network…</p>');
  $('page-label').textContent = ({ overview: 'Overview', transfers: 'Transfers', settings: 'Settings', device: 'File browser' })[page];
  $('footer-device').textContent = `${state.self.name} · Nearlink ${state.self.version || ''} · Sharing while Nearlink is open`;
  setHTML($('pairings'), [...state.incoming.map(p => ({ ...p, incoming: true, device: p.name, approved: p.localApproved })), ...state.outgoing].map(p => `<section class="pairing"><div><h3>Pair with ${esc(p.device)}</h3><p>Check that this exact code appears on both computers.</p><div class="pair-code">${esc(p.code)}</div><p>${p.approved ? 'Approved here. Waiting for the other computer…' : 'Approve on both computers only if the codes match.'}${p.error ? ' ' + esc(p.error) : ''}</p></div><div class="actions">${button('decline-pair', 'Cancel', `data-id="${esc(p.id)}" data-incoming="${!!p.incoming}"`)}${p.approved ? '' : button('approve-pair', 'Codes match', `data-id="${esc(p.id)}" data-incoming="${!!p.incoming}"`, 'primary')}</div></section>`).join(''));
  const focusedSearch = document.activeElement?.dataset?.search;
  const caret = focusedSearch ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scrolls = [...document.querySelectorAll('[data-scrollkey]')].map(e => [e.dataset.scrollkey, e.scrollTop]);
  if (page === 'transfers') renderTransfers();
  else if (document.activeElement?.id !== 'device-name') setHTML($('main'), page === 'overview' ? overview() : page === 'settings' ? settings() : explorer());
  if (focusedSearch) { const input = document.querySelector(`[data-search="${focusedSearch}"]`); if (input && !input.disabled) { input.focus({preventScroll:true}); input.setSelectionRange(...caret); } }
  for (const [key, top] of scrolls) { const el = document.querySelector(`[data-scrollkey="${key}"]`); if (el) el.scrollTop = top; }
}
async function browse() {
  const location = `${selectedDevice}:${currentShare?.id}:${currentPath}`;
  if (location !== remoteLocation) { paneOptions.network.query = ''; remoteLocation = location; }
  const generation = ++browseGeneration;
  loading = true; selected.clear(); render();
  try { const result = await api.invoke('remote:browse', selectedDevice, currentShare?.id, currentPath); if (generation === browseGeneration) remote = result; }
  catch (e) { if (generation === browseGeneration) { remote = null; toast(e.message); } }
  finally { if (generation === browseGeneration) { loading = false; render(); } }
}
// Drag payloads stay in this renderer; external drops are resolved from native File objects.
function clearDrop() { document.querySelectorAll('.drop-ready,.drop-blocked').forEach(el => { el.classList.remove('drop-ready','drop-blocked'); delete el.dataset.dropMessage; }); }
function dropProblem(side) {
  if (dragSource?.side === side) return 'Drop into the other pane to copy.';
  if (side === 'local') {
    if (!dragSource) return 'Drop Finder or Explorer items into the network pane.';
    if (!localFolder || localLoading) return 'Open a local destination folder first.';
    if (!state.devices.some(d => d.id === dragSource.device && d.paired)) return 'The source computer is offline.';
  } else {
    if (!state.devices.some(d => d.id === selectedDevice && d.paired)) return 'Open a paired online computer first.';
    if (!currentShare || loading) return 'Open a shared destination folder first.';
    if (!currentShare.writable) return 'This shared folder is read-only.';
  }
  return '';
}
document.addEventListener('dragstart', event => {
  const row = event.target.closest('[data-drag-side]');
  if (!row || event.target.matches('input')) { event.preventDefault(); return; }
  const side = row.dataset.dragSide, local = side === 'local';
  const entries = local ? localFolder?.entries : remote?.entries;
  const entry = entries?.[Number(row.dataset.dragIndex)];
  if (!entry || localLoading || loading) { event.preventDefault(); return; }
  const picks = local ? localSelected : selected, key = local ? entry.id : entry.name;
  const items = picks.has(key) ? [...picks] : [key];
  dragSource = { side, device: selectedDevice, share: currentShare?.id,
    items: local ? items : items.map(name => currentPath ? currentPath + '/' + name : name) };
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-nearlink-items', 'copy');
  event.dataTransfer.setData('text/plain', items.length + ' Nearlink item(s)');
});
function dragOver(event) {
  if (!dragSource && Array.from(event.dataTransfer.types).includes('Files')) {
    externalDrag = true;
    clearTimeout(dragRefreshTimer);
    dragRefreshTimer = setTimeout(() => { externalDrag = false; clearDrop(); render(); }, 1500);
  }
  event.preventDefault(); // Never navigate the app to an external file.
  const pane = event.target.closest('[data-drop-side]');
  clearDrop();
  if (!pane || (!dragSource && !Array.from(event.dataTransfer.types).includes('Files'))) { event.dataTransfer.dropEffect = 'none'; return; }
  const problem = dropProblem(pane.dataset.dropSide);
  pane.classList.add(problem ? 'drop-blocked' : 'drop-ready');
  pane.dataset.dropMessage = problem || 'Release to copy into this folder';
  event.dataTransfer.dropEffect = problem ? 'none' : 'copy';
}
document.addEventListener('dragenter', dragOver);
document.addEventListener('dragover', dragOver);
document.addEventListener('dragleave', event => {
  const pane = event.target.closest('[data-drop-side]');
  if (pane && !pane.contains(event.relatedTarget)) clearDrop();
});
document.addEventListener('dragend', () => { dragSource = null; externalDrag = false; clearTimeout(dragRefreshTimer); clearDrop(); render(); });
document.addEventListener('drop', async event => {
  event.preventDefault(); externalDrag = false; clearTimeout(dragRefreshTimer); clearDrop();
  const pane = event.target.closest('[data-drop-side]');
  const source = dragSource;
  try {
    if (!pane) return;
    const side = pane.dataset.dropSide, problem = dropProblem(side);
    if (problem) throw new Error(problem);
    let id;
    if (source) {
      id = await api.invoke('transfer:between', {
        device: side === 'local' ? source.device : selectedDevice,
        share: side === 'local' ? source.share : currentShare.id,
        relative: currentPath, direction: side === 'local' ? 'receive' : 'send',
        destination: localFolder?.id, items: source.items, move: false
      });
    } else {
      id = await api.dropFiles(Array.from(event.dataTransfer.files), { device: selectedDevice, share: currentShare.id, relative: currentPath });
    }
    if (id) toast('Copy queued. See Transfers for progress.');
  } catch (error) { toast(error.message); }
  finally { dragSource = null; render(); }
});
document.addEventListener('click', async event => {
  const b = event.target.closest('[data-action]'); if (!b) return;
  const action = b.dataset.action; b.disabled = true;
  try {
    if (['overview', 'transfers', 'settings'].includes(action)) { page = action; render(); }
    else if (action === 'toggle-theme') { state.theme = await api.invoke('settings:theme', state.theme === 'dark' ? 'light' : 'dark'); render(); }
    else if (action === 'view-mode') { paneOptions[b.dataset.side].view = b.dataset.mode; render(); await savePreferences(); }
    else if (action === 'sort-direction') { const p = paneOptions[b.dataset.side]; p.direction = p.direction === 'asc' ? 'desc' : 'asc'; render(); await savePreferences(); }
    else if (action === 'clear-search') { paneOptions[b.dataset.side].query = ''; render(); }
    else if (action === 'device') { page = 'device'; render(); if (!localFolder) await browseLocal(); }
    else if (action === 'network-root') { ++browseGeneration; loading = false; selectedDevice = null; currentShare = null; currentPath = ''; remote = null; selected.clear(); render(); }
    else if (action === 'local-choose') await browseLocal(undefined, true);
    else if (action === 'local-home') await browseLocal();
    else if (action === 'local-up') await browseLocal(localFolder.parent);
    else if (action === 'local-refresh') await browseLocal(localFolder?.id);
    else if (action === 'local-folder') await browseLocal(localFolder.entries[Number(b.dataset.index)].id);
    else if (action === 'copy-send' || action === 'move-send') await copyBetween('send', action === 'move-send');
    else if (action === 'copy-receive' || action === 'move-receive') await copyBetween('receive', action === 'move-receive');
    else if (action === 'refresh') { state = await api.invoke('devices:refresh'); render(); }
    else if (action === 'add-share') await api.invoke('shares:add');
    else if (action === 'remove-share') await api.invoke('shares:remove', b.dataset.id);
    else if (action === 'forget') await api.invoke('trust:remove', b.dataset.id);
    else if (action === 'network-settings') await api.invoke('network:settings');
    else if (action === 'open-settings') await api.invoke('settings:open');
    else if (action === 'pair') await api.invoke('pair:start', b.dataset.id);
    else if (action === 'approve-pair' || action === 'decline-pair') await api.invoke(action === 'approve-pair' ? 'pair:approve' : 'pair:reject', b.dataset.id, b.dataset.incoming === 'true');
    else if (action === 'open-device') { selectedDevice = b.dataset.id; page = 'device'; currentShare = null; currentPath = ''; remote = null; await Promise.all([browse(), localFolder ? Promise.resolve() : browseLocal()]); }
    else if (action === 'open-share') { currentShare = remote.shares.find(s => s.id === b.dataset.id); currentPath = ''; await browse(); }
    else if (action === 'open-folder') { const entry = remote.entries[Number(b.dataset.index)]; currentPath = currentPath ? currentPath + '/' + entry.name : entry.name; await browse(); }
    else if (action === 'up') { if (!currentShare) { selectedDevice = null; remote = null; selected.clear(); render(); } else { if (!currentPath) currentShare = null; else currentPath = currentPath.split('/').slice(0, -1).join('/'); await browse(); } }
    else if (action === 'browse-refresh') { if (selectedDevice) await browse(); else { state = await api.invoke('devices:refresh'); render(); } }
    else if (['send', 'send-folder', 'send-move'].includes(action)) {
      const id = await api.invoke('transfer:send', selectedDevice, currentShare.id, currentPath, action === 'send-folder' ? 'folder' : 'files', action === 'send-move');
      if (id) { page = 'transfers'; render(); }
    } else if (action === 'receive' || action === 'receive-move') {
      const id = await api.invoke('transfer:receive', selectedDevice, currentShare.id, [...selected].map(name => currentPath ? currentPath + '/' + name : name), action === 'receive-move');
      if (id) { page = 'transfers'; render(); }
    } else if (action === 'cancel-transfer') await api.invoke('transfer:cancel', b.dataset.id);
  } catch (e) { toast(e.message); }
  finally { if (b.isConnected) b.disabled = false; }
});
document.addEventListener('change', async e => {
  try {
    if (e.target.dataset.sort) { paneOptions[e.target.dataset.sort].sort = e.target.value; render(); await savePreferences(); }
    else if (e.target.dataset.write) await api.invoke('shares:write', e.target.dataset.write, e.target.checked);
    else if (e.target.dataset.pickSide) {
      const local = e.target.dataset.pickSide === 'local';
      const entry = (local ? localFolder.entries : remote.entries)[Number(e.target.dataset.index)];
      const picks = local ? localSelected : selected; const key = local ? entry.id : entry.name;
      if (e.target.checked) picks.add(key); else picks.delete(key); render();
    } else if (e.target.dataset.selectAll) {
      const local = e.target.dataset.selectAll === 'local'; const picks = local ? localSelected : selected;
      picks.clear(); if (e.target.checked) FileView.visible(local ? localFolder.entries : remote.entries, paneOptions[local ? 'local' : 'network']).forEach(e => picks.add(local ? e.id : e.name)); render();
    }
    else if (e.target.dataset.entry !== undefined) { const name = remote.entries[Number(e.target.dataset.entry)].name; if (e.target.checked) selected.add(name); else selected.delete(name); render(); }
    else if (e.target.id === 'select-all') { selected.clear(); if (e.target.checked) remote.entries.forEach(entry => selected.add(entry.name)); render(); }
  } catch (error) { toast(error.message); }
});
document.addEventListener('input', event => {
  const side = event.target.dataset.search; if (!side) return;
  paneOptions[side].query = event.target.value;
  const entries = side === 'local' ? localFolder?.entries || [] : remote?.entries || [];
  const visibleKeys = new Set(FileView.visible(entries, paneOptions[side]).map(e => side === 'local' ? e.id : e.name));
  const picks = side === 'local' ? localSelected : selected;
  for (const key of picks) if (!visibleKeys.has(key)) picks.delete(key);
  render();
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'name-form') return;
  e.preventDefault();
  try { await api.invoke('settings:name', $('device-name').value); toast('Computer name updated.'); }
  catch (error) { toast(error.message); }
});
api.onState(next => {
  const completed = state && next.transfers.some(t => t.status === 'complete' && state.transfers.find(old => old.id === t.id)?.status === 'running');
  loadPreferences(next); state = next; render();
  if (completed && page === 'device') { if (localFolder) browseLocal(localFolder.id); if (selectedDevice && currentShare) browse(); }
});
api.invoke('state:get').then(next => { loadPreferences(next); state = next; render(); }).catch(e => toast(e.message));
