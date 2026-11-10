const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, randomBytes } = require('node:crypto');
const { LocalBrowser } = require('./core/local-browser.cjs');
const { Store } = require('./core/store.cjs');
const { FileServer } = require('./core/server.cjs');
const { Discovery } = require('./core/discovery.cjs');
const { Transfers, route } = require('./core/transfers.cjs');
const { json } = require('./core/transport.cjs');
const { pairingCode } = require('./core/security.cjs');

let win, store, server, discovery, transfers, localBrowser, quitting = false;
const outgoing = new Map(); const warnings = [];
const uiPath = path.join(__dirname, 'ui', 'index.html');
if (process.env.NEARLINK_DATA_DIR) app.setPath('userData', path.resolve(process.env.NEARLINK_DATA_DIR));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('Nearlink could not start', error.message); app.exit(1); });
}
function state() {
  return { self: { id: store.data.id, name: store.data.name, platform: process.platform, version: app.getVersion() }, shares: store.data.shares,
    devices: discovery.list(), incoming: server.pairingRequests(), outgoing: [...outgoing.values()].map(({ peer, ...p }) => ({ ...p, device: peer.name })),
    trusted: store.data.trusted, transfers: transfers.list(), warnings: warnings.slice(-3), port: server.port, network: discovery.diagnostics(), theme: store.data.theme === 'dark' ? 'dark' : 'light', browserPreferences: store.data.browserPreferences };
}
function emit() { if (win && !win.isDestroyed()) win.webContents.send('state', state()); }
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Unknown request source.');
    return fn(...args);
  });
}
async function start() {
  store = await new Store(app.getPath('userData')).init();
  server = new FileServer(store); await server.start();
  discovery = new Discovery(store, server.port); transfers = new Transfers(store);
  for (const source of [server, discovery, transfers]) source.on('change', emit);
  discovery.on('warning', message => { if (warnings.at(-1) !== message) warnings.push(message); emit(); });
  discovery.start();
  localBrowser = new LocalBrowser(app.getPath('home'));
  handle('local:browse', id => localBrowser.browse(id));
  handle('local:choose', async () => {
    const choice = await dialog.showOpenDialog(win, { title: 'Browse a local folder or drive', properties: ['openDirectory', 'createDirectory'] });
    return choice.canceled ? null : localBrowser.openPath(choice.filePaths[0]);
  });
  handle('transfer:drop', async (paths, { device, share, relative }) => {
    const peer = discovery.peer(device);
    if (!peer.paired) throw new Error('Pair these computers first.');
    if (!Array.isArray(paths) || !paths.length || paths.length > 10000 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Drop local files or folders.');
    const files = await Promise.all([...new Set(paths)].map(async file => {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Symbolic links and special files cannot be transferred.');
      return fs.realpath(file);
    }));
    return transfers.upload(peer, share, relative, files, false);
  });
  handle('transfer:between', async ({ device, share, relative, direction, items, destination, move }) => {
    const peer = discovery.peer(device);
    if (!peer.paired) throw new Error('Pair these computers first.');
    if (!Array.isArray(items) || !items.length || items.length > 10000 || items.some(i => typeof i !== 'string')) throw new Error('Select files or folders to copy.');
    if (direction === 'send') {
      const files = await Promise.all(items.map(id => localBrowser.resolve(id)));
      if (move && (await Promise.all(files.map(f => fs.stat(f)))).some(s => s.isDirectory())) throw new Error('Folder copies are supported. Move only individual files.');
      if (move && !await confirmMove()) return;
      return transfers.upload(peer, share, relative, files, !!move);
    }
    if (direction !== 'receive') throw new Error('Invalid transfer direction.');
    const folder = await localBrowser.resolve(destination, true);
    if (move && !await confirmMove()) return;
    return transfers.download(peer, share, items, folder, !!move);
  });
  handle('browser:preferences', async preferences => {
    const clean = {};
    for (const side of ['local', 'network']) {
      const p = preferences?.[side];
      if (!p || !['grid','list','details'].includes(p.view) || !['name','size','type','modified'].includes(p.sort) || !['asc','desc'].includes(p.direction)) throw new Error('Invalid browser preferences.');
      clean[side] = { view: p.view, sort: p.sort, direction: p.direction };
    }
    store.data.browserPreferences = clean; await store.save();
  });
  handle('settings:theme', async theme => {
    if (!['light', 'dark'].includes(theme)) throw new Error('Invalid appearance.');
    store.data.theme = theme; await store.save();
    nativeTheme.themeSource = theme;
    win.setBackgroundColor(theme === 'dark' ? '#141c18' : '#f7f8f5');
    emit(); return theme;
  });
  handle('state:get', state);
  handle('devices:refresh', async () => { await discovery.rescan(); return state(); });
  handle('settings:name', async name => {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Use a name between 1 and 80 characters.');
    store.data.name = name.trim(); await store.save(); emit();
  });
  handle('shares:add', async () => {
    const choice = await dialog.showOpenDialog(win, { title: 'Choose a folder to share', properties: ['openDirectory'] });
    if (choice.canceled) return;
    const folder = await fs.realpath(choice.filePaths[0]);
    if (store.data.shares.some(s => s.path === folder)) throw new Error('This folder is already shared.');
    store.data.shares.push({ id: randomUUID(), name: path.basename(folder) || folder, path: folder, writable: false });
    await store.save(); emit();
  });
  handle('shares:write', async (id, writable) => { const s = store.data.shares.find(s => s.id === id); if (!s || typeof writable !== 'boolean') throw new Error('Invalid shared folder.'); s.writable = writable; await store.save(); emit(); });
  handle('shares:remove', async id => { store.data.shares = store.data.shares.filter(s => s.id !== id); await store.save(); emit(); });
  handle('trust:remove', async id => { store.data.trusted = store.data.trusted.filter(p => p.id !== id); await store.save(); await discovery.refresh(); emit(); });
  handle('pair:start', async deviceId => {
    const peer = discovery.peer(deviceId);
    const nonce = randomBytes(32).toString('hex');
    const reply = await json(store, peer, '/pair/start', { id: store.data.id, name: store.data.name, nonce });
    if (!/^[a-f0-9-]{36}$/.test(reply.id || '') || !Number.isFinite(reply.expires) || reply.expires > Date.now() + 125000) throw new Error('Invalid pairing response.');
    if (typeof reply.nonce !== 'string' || !reply.nonce.startsWith(nonce) || !/^[a-f0-9]{128}$/.test(reply.nonce)) throw new Error('Invalid pairing response.');
    outgoing.set(reply.id, { id: reply.id, peer, code: pairingCode(store.fingerprint, peer.fingerprint, reply.nonce), expires: reply.expires, approved: false }); emit();
  });
  handle('pair:approve', async (id, incoming) => {
    if (incoming) await server.approve(id);
    else {
      const p = outgoing.get(id); if (!p) throw new Error('Pairing expired.');
      await json(store, p.peer, '/pair/confirm?id=' + encodeURIComponent(id), {}); p.approved = true;
    }
    emit();
  });
  handle('pair:reject', async (id, incoming) => { if (incoming) server.reject(id); else outgoing.delete(id); emit(); });
  handle('remote:browse', async (id, share, relative = '') => {
    const peer = discovery.peer(id); if (!peer.paired) throw new Error('Pair these computers first.');
    return share ? json(store, peer, route('/list', share, relative)) : json(store, peer, '/shares');
  });
  handle('transfer:send', async (id, share, relative, kind, move) => {
    const peer = discovery.peer(id); if (!peer.paired) throw new Error('Pair these computers first.');
    if (move && kind === 'folder') throw new Error('Move supports individual files only.');
    const choice = await dialog.showOpenDialog(win, { title: move ? 'Select files to move' : 'Select items to send', properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] });
    if (choice.canceled) return;
    if (move && !await confirmMove()) return;
    return transfers.upload(peer, share, relative, choice.filePaths, !!move);
  });
  handle('transfer:receive', async (id, share, paths, move) => {
    const peer = discovery.peer(id); if (!peer.paired) throw new Error('Pair these computers first.');
    if (!Array.isArray(paths) || !paths.length || paths.length > 10000 || paths.some(p => typeof p !== 'string')) throw new Error('Select files to receive.');
    const choice = await dialog.showOpenDialog(win, { title: 'Choose destination folder', properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled) return;
    if (move && !await confirmMove()) return;
    return transfers.download(peer, share, paths, choice.filePaths[0], !!move);
  });
  handle('transfer:cancel', id => transfers.cancel(id));
  handle('network:settings', () => shell.openExternal(process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork' : 'ms-settings:network-status'));
  handle('settings:open', () => shell.openPath(app.getPath('userData')));
  const poll = setInterval(async () => {
    for (const [id, p] of outgoing) {
      if (p.expires < Date.now()) { outgoing.delete(id); emit(); continue; }
      if (!p.approved || p.polling) continue;
      p.polling = true;
      try {
        const reply = await json(store, p.peer, '/pair/status?id=' + encodeURIComponent(id));
        if (reply.complete) { await store.trust(p.peer); outgoing.delete(id); await discovery.refresh(); emit(); }
      } catch (e) { p.error = e.message; emit(); }
      finally { p.polling = false; }
    }
  }, 1200); poll.unref();
  nativeTheme.themeSource = store.data.theme === 'dark' ? 'dark' : 'light';
  win = new BrowserWindow({ show: false, width: 1240, height: 830, minWidth: 980, minHeight: 650, title: 'Nearlink', backgroundColor: store.data.theme === 'dark' ? '#141c18' : '#f7f8f5',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  win.on('close', e => {
    if (quitting) return;
    if (transfers.list().some(t => ['queued', 'running'].includes(t.status))) {
      const answer = dialog.showMessageBoxSync(win, { type: 'question', message: 'Quit and cancel active transfers?', detail: 'Completed files will be kept. This computer will disappear from nearby devices.', buttons: ['Keep transferring', 'Quit'], defaultId: 0, cancelId: 0 });
      if (answer === 0) { e.preventDefault(); return; }
    }
    app.quit();
  });
  await win.loadFile(uiPath);
  win.show();
}
async function confirmMove() {
  const answer = await dialog.showMessageBox(win, { type: 'question', message: 'Move these files?', detail: 'After each copy passes checksum verification, its original will be deleted. Keep source files closed during the move.', buttons: ['Cancel', 'Move files'], defaultId: 0, cancelId: 0 });
  return answer.response === 1;
}
app.on('before-quit', e => {
  if (quitting) return;
  e.preventDefault(); quitting = true;
  for (const t of transfers?.list() || []) transfers.cancel(t.id);
  Promise.allSettled([discovery?.stop(), server?.stop()]).finally(() => app.exit(0));
  setTimeout(() => app.exit(0), 2500).unref();
});
app.on('window-all-closed', () => app.quit());
