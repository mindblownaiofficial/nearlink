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

const BACKGROUND = '#0a0a0b';
const HEADER = '#101011';
const ACTIVE = ['queued', 'running'];
const MAX_ITEMS = 10000;

let win, store, server, discovery, transfers, localBrowser;
let quitting = false;
const outgoing = new Map();
const warnings = [];

// A separate data folder keeps a development copy from touching the installed app's identity.
const dataDirArg = process.argv.find(arg => arg.startsWith('--data-dir='));
const dataDir = dataDirArg ? dataDirArg.slice('--data-dir='.length) : process.env.NEARLINK_DATA_DIR;
if (dataDir) app.setPath('userData', path.resolve(dataDir));

// Windows groups taskbar buttons and notifications by this id.
if (process.platform === 'win32') app.setAppUserModelId('local.nearlink.desktop');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    win?.show();
    win?.focus();
  });
  app
    .whenReady()
    .then(start)
    .catch(error => {
      dialog.showErrorBox('Nearlink could not start', error.message);
      app.exit(1);
    });
}

function state() {
  return {
    self: {
      id: store.data.id,
      name: store.data.name,
      platform: process.platform,
      version: app.getVersion(),
      fingerprint: store.fingerprint,
    },
    shares: store.data.shares,
    devices: discovery.list(),
    incoming: server.pairingRequests(),
    outgoing: [...outgoing.values()].map(({ peer, polling, ...pairing }) => ({ ...pairing, device: peer.name })),
    trusted: store.data.trusted,
    transfers: transfers.list(),
    warnings: warnings.slice(-3),
    port: server.port,
    network: discovery.diagnostics(),
    browserPreferences: store.data.browserPreferences,
  };
}

function emit() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state());
}

// Only the app's own window may call into the main process.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Unknown request source.');
    }
    return fn(...args);
  });
}

function pairedPeer(id) {
  const peer = discovery.peer(id);
  if (!peer.paired) throw new Error('Pair these computers first.');
  return peer;
}

function validList(items) {
  return (
    Array.isArray(items) && items.length > 0 && items.length <= MAX_ITEMS && items.every(i => typeof i === 'string')
  );
}

async function confirmMove() {
  const answer = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'Move these files?',
    detail:
      'After each copy passes checksum verification, its original will be deleted. Keep source files closed during the move.',
    buttons: ['Cancel', 'Move files'],
    defaultId: 0,
    cancelId: 0,
  });
  return answer.response === 1;
}

function registerHandlers() {
  handle('state:get', state);

  // ── Local file browser ────────────────────────────────────────────────
  handle('local:browse', id => localBrowser.browse(id));
  handle('local:choose', async () => {
    const choice = await dialog.showOpenDialog(win, {
      title: 'Browse a local folder or drive',
      properties: ['openDirectory', 'createDirectory'],
    });
    return choice.canceled ? null : localBrowser.openPath(choice.filePaths[0]);
  });
  handle('browser:preferences', async preferences => {
    const clean = {};
    for (const side of ['local', 'network']) {
      const p = preferences?.[side];
      const valid =
        p &&
        ['grid', 'list', 'details'].includes(p.view) &&
        ['name', 'size', 'type', 'modified'].includes(p.sort) &&
        ['asc', 'desc'].includes(p.direction);
      if (!valid) throw new Error('Invalid browser preferences.');
      clean[side] = { view: p.view, sort: p.sort, direction: p.direction };
    }
    store.data.browserPreferences = clean;
    await store.save();
  });

  // ── Devices, pairing and trust ────────────────────────────────────────
  handle('devices:refresh', async () => {
    await discovery.rescan();
    return state();
  });
  handle('pair:start', async deviceId => {
    const peer = discovery.peer(deviceId);
    const nonce = randomBytes(32).toString('hex');
    const reply = await json(store, peer, '/pair/start', { id: store.data.id, name: store.data.name, nonce });
    const validReply =
      /^[a-f0-9-]{36}$/.test(reply.id || '') &&
      Number.isFinite(reply.expires) &&
      reply.expires <= Date.now() + 125000 &&
      typeof reply.nonce === 'string' &&
      reply.nonce.startsWith(nonce) &&
      /^[a-f0-9]{128}$/.test(reply.nonce);
    if (!validReply) throw new Error('Invalid pairing response.');
    outgoing.set(reply.id, {
      id: reply.id,
      peer,
      code: pairingCode(store.fingerprint, peer.fingerprint, reply.nonce),
      expires: reply.expires,
      approved: false,
    });
    emit();
  });
  handle('pair:approve', async (id, incoming) => {
    if (incoming) await server.approve(id);
    else {
      const pairing = outgoing.get(id);
      if (!pairing) throw new Error('Pairing expired.');
      await json(store, pairing.peer, '/pair/confirm?id=' + encodeURIComponent(id), {});
      pairing.approved = true;
    }
    emit();
  });
  handle('pair:reject', async (id, incoming) => {
    if (incoming) server.reject(id);
    else outgoing.delete(id);
    emit();
  });
  handle('trust:remove', async id => {
    store.data.trusted = store.data.trusted.filter(p => p.id !== id);
    await store.save();
    await discovery.refresh();
    emit();
  });

  // ── Shared folders ────────────────────────────────────────────────────
  handle('shares:add', async () => {
    const choice = await dialog.showOpenDialog(win, {
      title: 'Choose a folder to share',
      properties: ['openDirectory'],
    });
    if (choice.canceled) return;
    const folder = await fs.realpath(choice.filePaths[0]);
    if (store.data.shares.some(s => s.path === folder)) throw new Error('This folder is already shared.');
    store.data.shares.push({ id: randomUUID(), name: path.basename(folder) || folder, path: folder, writable: false });
    await store.save();
    emit();
  });
  handle('shares:write', async (id, writable) => {
    const share = store.data.shares.find(s => s.id === id);
    if (!share || typeof writable !== 'boolean') throw new Error('Invalid shared folder.');
    share.writable = writable;
    await store.save();
    emit();
  });
  handle('shares:remove', async id => {
    store.data.shares = store.data.shares.filter(s => s.id !== id);
    await store.save();
    emit();
  });
  handle('shares:reveal', async id => {
    const share = store.data.shares.find(s => s.id === id);
    if (!share) throw new Error('Invalid shared folder.');
    const problem = await shell.openPath(share.path);
    if (problem) throw new Error('This folder is no longer available.');
  });

  // ── Remote browsing and transfers ─────────────────────────────────────
  handle('remote:browse', async (id, share, relative = '') => {
    const peer = pairedPeer(id);
    return share ? json(store, peer, route('/list', share, relative)) : json(store, peer, '/shares');
  });
  handle('transfer:drop', async (paths, { device, share, relative }) => {
    const peer = pairedPeer(device);
    if (!validList(paths) || paths.some(p => !path.isAbsolute(p))) throw new Error('Drop local files or folders.');
    const files = await Promise.all(
      [...new Set(paths)].map(async file => {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          throw new Error('Symbolic links and special files cannot be transferred.');
        }
        return fs.realpath(file);
      }),
    );
    return transfers.upload(peer, share, relative, files, false);
  });
  handle('transfer:between', async ({ device, share, relative, direction, items, destination, move }) => {
    const peer = pairedPeer(device);
    if (!validList(items)) throw new Error('Select files or folders to copy.');
    if (direction === 'send') {
      const files = await Promise.all(items.map(id => localBrowser.resolve(id)));
      if (move && (await Promise.all(files.map(f => fs.stat(f)))).some(s => s.isDirectory())) {
        throw new Error('Folder copies are supported. Move only individual files.');
      }
      if (move && !(await confirmMove())) return;
      return transfers.upload(peer, share, relative, files, !!move);
    }
    if (direction !== 'receive') throw new Error('Invalid transfer direction.');
    const folder = await localBrowser.resolve(destination, true);
    if (move && !(await confirmMove())) return;
    return transfers.download(peer, share, items, folder, !!move);
  });
  handle('transfer:send', async (id, share, relative, kind) => {
    const peer = pairedPeer(id);
    const choice = await dialog.showOpenDialog(win, {
      title: 'Select items to send',
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    if (choice.canceled) return;
    return transfers.upload(peer, share, relative, choice.filePaths, false);
  });
  handle('transfer:cancel', id => transfers.cancel(id));
  handle('transfer:clear', () => {
    transfers.jobs = transfers.jobs.filter(job => ACTIVE.includes(job.status));
    emit();
  });

  // ── Settings ──────────────────────────────────────────────────────────
  handle('settings:name', async name => {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) {
      throw new Error('Use a name between 1 and 80 characters.');
    }
    store.data.name = name.trim();
    await store.save();
    emit();
  });
  handle('settings:open', () => shell.openPath(app.getPath('userData')));
  handle('network:settings', () =>
    shell.openExternal(
      process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'
        : 'ms-settings:network-status',
    ),
  );
}

// The side that started a pairing polls until the other computer has approved it too.
function watchOutgoingPairings() {
  const poll = setInterval(async () => {
    for (const [id, pairing] of outgoing) {
      if (pairing.expires < Date.now()) {
        outgoing.delete(id);
        emit();
        continue;
      }
      if (!pairing.approved || pairing.polling) continue;
      pairing.polling = true;
      try {
        const reply = await json(store, pairing.peer, '/pair/status?id=' + encodeURIComponent(id));
        if (reply.complete) {
          await store.trust(pairing.peer);
          outgoing.delete(id);
          await discovery.refresh();
          emit();
        }
      } catch (error) {
        pairing.error = error.message;
        emit();
      } finally {
        pairing.polling = false;
      }
    }
  }, 1200);
  poll.unref();
}

// The app header doubles as the title bar: macOS keeps its window buttons on the left,
// Windows draws minimise / maximise / close over the right end of the header.
function windowChrome() {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 21 } };
  if (process.platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: { color: HEADER, symbolColor: '#ededef', height: 58 } };
  }
  return {};
}

async function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 840,
    minWidth: 1040,
    minHeight: 660,
    title: 'Nearlink',
    backgroundColor: BACKGROUND,
    ...windowChrome(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  win.on('close', event => {
    if (quitting) return;
    if (transfers.list().some(t => ACTIVE.includes(t.status))) {
      const answer = dialog.showMessageBoxSync(win, {
        type: 'question',
        message: 'Quit and cancel active transfers?',
        detail: 'Completed files will be kept. This computer will disappear from nearby devices.',
        buttons: ['Keep transferring', 'Quit'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer === 0) {
        event.preventDefault();
        return;
      }
    }
    app.quit();
  });
  await win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.show();
}

async function start() {
  store = await new Store(app.getPath('userData')).init();
  server = new FileServer(store);
  await server.start();
  discovery = new Discovery(store, server.port);
  transfers = new Transfers(store);
  localBrowser = new LocalBrowser(app.getPath('home'));

  for (const source of [server, discovery, transfers]) source.on('change', emit);
  discovery.on('warning', message => {
    if (warnings.at(-1) !== message) warnings.push(message);
    emit();
  });
  discovery.start();

  registerHandlers();
  watchOutgoingPairings();
  await createWindow();
}

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  for (const transfer of transfers?.list() || []) transfers.cancel(transfer.id);
  Promise.allSettled([discovery?.stop(), server?.stop()]).finally(() => app.exit(0));
  setTimeout(() => app.exit(0), 2500).unref();
});
app.on('window-all-closed', () => app.quit());
