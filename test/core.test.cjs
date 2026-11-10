// Runs on macOS and Windows: `npm test`. No Electron needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Store } = require('../src/core/store.cjs');
const { FileServer } = require('../src/core/server.cjs');
const { Transfers } = require('../src/core/transfers.cjs');
const { json } = require('../src/core/transport.cjs');
const security = require('../src/core/security.cjs');
const FileView = require('../src/ui/file-view.js');

const anyAddress = () => true;

test('filenames that are unsafe on either system are refused', () => {
  for (const bad of [
    '../secret',
    'a/../b',
    'a\\b',
    '/etc/passwd',
    'CON',
    'nul.txt',
    'trailing.',
    'trailing ',
    'a:b',
    '.nearlink-x.part',
  ]) {
    assert.throws(() => security.relativeParts(bad), new RegExp('Invalid file path|not safely transferable'), bad);
  }
  assert.deepEqual(security.relativeParts('Footage/take 2 (final).mov'), ['Footage', 'take 2 (final).mov']);
  assert.deepEqual(security.relativeParts(''), []);
});

test('only addresses on a real local network interface are allowed', () => {
  const v4 = (address, netmask) => ({ address, netmask, family: 'IPv4', internal: false });
  const windows = {
    'Wi-Fi': [v4('192.168.1.10', '255.255.255.0')],
    'vEthernet (WSL)': [v4('172.20.0.1', '255.255.240.0')],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
  };
  assert.equal(security.lanAddress('192.168.1.77', windows), true);
  assert.equal(security.lanAddress('::ffff:192.168.1.77', windows), true);
  assert.equal(security.lanAddress('192.168.2.77', windows), false, 'different subnet');
  assert.equal(security.lanAddress('172.20.5.5', windows), false, 'virtual switch');
  assert.equal(security.lanAddress('8.8.8.8', windows), false, 'public address');
  const mac = { en0: [v4('10.0.0.5', '255.255.255.0')], utun3: [v4('10.8.0.2', '255.255.255.0')] };
  assert.equal(security.lanAddress('10.0.0.9', mac), true);
  assert.equal(security.lanAddress('10.8.0.9', mac), false, 'VPN tunnel');
});

test('both computers derive the same pairing code', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const code = security.pairingCode(a, b, 'nonce');
  assert.equal(code, security.pairingCode(b, a, 'nonce'));
  assert.match(code, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  assert.notEqual(code, security.pairingCode(a, b, 'other'));
});

test('file lists filter and sort with folders first', () => {
  const entries = [
    { name: 'b.txt', directory: false, size: 5, modified: 2 },
    { name: 'Zeta', directory: true, size: 0, modified: 1 },
    { name: 'a10.txt', directory: false, size: 50, modified: 3 },
    { name: 'a2.txt', directory: false, size: 1, modified: 4 },
  ];
  const names = options => FileView.visible(entries, { ...FileView.defaults(), ...options }).map(e => e.name);
  assert.deepEqual(names({}), ['Zeta', 'a2.txt', 'a10.txt', 'b.txt']);
  assert.deepEqual(names({ sort: 'size', direction: 'desc' }), ['Zeta', 'a10.txt', 'b.txt', 'a2.txt']);
  assert.deepEqual(names({ query: 'A TXT' }), ['a2.txt', 'a10.txt']);
});

test('two computers: trust, browse, copy both ways, never overwrite', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nearlink-test-'));
  const here = await new Store(path.join(root, 'here')).init();
  const there = await new Store(path.join(root, 'there')).init();
  const inbox = path.join(root, 'inbox');
  const locked = path.join(root, 'locked');
  const outbox = path.join(root, 'outbox');
  const downloads = path.join(root, 'downloads');
  for (const dir of [inbox, locked, outbox, path.join(outbox, 'Project', 'audio'), downloads]) {
    await fs.mkdir(dir, { recursive: true });
  }
  there.data.shares = [
    { id: 'inbox', name: 'Inbox', path: await fs.realpath(inbox), writable: true },
    { id: 'locked', name: 'Locked', path: await fs.realpath(locked), writable: false },
  ];

  const server = new FileServer(there, { allowAddress: anyAddress });
  const port = await server.start(0, '127.0.0.1');
  const transfers = new Transfers(here, { allowAddress: anyAddress });
  t.after(async () => {
    await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const peer = { id: there.data.id, name: 'There', host: '127.0.0.1', port, fingerprint: there.fingerprint };
  const ask = (route, body) => json(here, peer, route, body, { allowAddress: anyAddress });
  const finish = async id => {
    for (;;) {
      const job = transfers.list().find(j => j.id === id);
      if (!['queued', 'running'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  // Strangers can say hello but cannot see anything.
  assert.equal((await ask('/hello')).trustsYou, false);
  await assert.rejects(ask('/shares'), /Pair these computers first/);
  await assert.rejects(
    json(here, { ...peer, fingerprint: 'f'.repeat(64) }, '/hello', undefined, { allowAddress: anyAddress }),
    /Device identity changed/,
  );

  await there.trust({ id: here.data.id, name: 'Here', fingerprint: here.fingerprint });
  assert.equal((await ask('/hello')).trustsYou, true);
  assert.deepEqual(
    (await ask('/shares')).shares.map(s => [s.id, s.writable]),
    [
      ['inbox', true],
      ['locked', false],
    ],
  );

  // Send a folder and a loose file.
  const movie = randomBytes(3 * 1024 * 1024 + 17);
  const voice = randomBytes(40000);
  await fs.writeFile(path.join(outbox, 'Project', 'movie.mov'), movie);
  await fs.writeFile(path.join(outbox, 'Project', 'audio', 'voice.wav'), voice);
  await fs.writeFile(path.join(outbox, 'notes.txt'), 'hello');
  const sources = [await fs.realpath(path.join(outbox, 'Project')), await fs.realpath(path.join(outbox, 'notes.txt'))];
  const sent = await finish(transfers.upload(peer, 'inbox', '', sources));
  assert.equal(sent.status, 'complete', sent.error);
  assert.equal(sent.files, 3);
  assert.deepEqual(await fs.readFile(path.join(inbox, 'Project', 'movie.mov')), movie);
  assert.deepEqual(await fs.readFile(path.join(inbox, 'Project', 'audio', 'voice.wav')), voice);
  assert.deepEqual(
    (await fs.readdir(inbox)).filter(name => name.startsWith('.nearlink-')),
    [],
    'no temporary files are left behind',
  );

  // The same name again is refused and the first copy is untouched.
  await fs.writeFile(path.join(outbox, 'notes.txt'), 'changed');
  const again = await finish(transfers.upload(peer, 'inbox', '', [sources[1]]));
  assert.equal(again.status, 'failed');
  assert.match(again.error, /already exists/);
  assert.equal(await fs.readFile(path.join(inbox, 'notes.txt'), 'utf8'), 'hello');

  // A read-only share refuses uploads; paths cannot escape a share.
  const refused = await finish(transfers.upload(peer, 'locked', '', [sources[1]]));
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /read-only/);
  await assert.rejects(
    ask('/list?share=inbox&path=' + encodeURIComponent('../here')),
    /not safely transferable|Invalid file path/,
  );

  // Receive the folder back into another place.
  const listing = await ask('/list?share=inbox&path=');
  assert.deepEqual(
    listing.entries.map(e => [e.name, e.directory]),
    [
      ['Project', true],
      ['notes.txt', false],
    ],
  );
  const received = await finish(transfers.download(peer, 'inbox', ['Project'], await fs.realpath(downloads)));
  assert.equal(received.status, 'complete', received.error);
  assert.deepEqual(await fs.readFile(path.join(downloads, 'Project', 'movie.mov')), movie);
  assert.deepEqual(await fs.readFile(path.join(downloads, 'Project', 'audio', 'voice.wav')), voice);

  // Move: the original goes only after the copy is verified.
  await fs.writeFile(path.join(outbox, 'move-me.bin'), voice);
  const moved = await finish(
    transfers.upload(peer, 'inbox', 'Project', [await fs.realpath(path.join(outbox, 'move-me.bin'))], true),
  );
  assert.equal(moved.status, 'complete', moved.error);
  assert.deepEqual(await fs.readFile(path.join(inbox, 'Project', 'move-me.bin')), voice);
  await assert.rejects(fs.stat(path.join(outbox, 'move-me.bin')), { code: 'ENOENT' });
});

test('a finished file never replaces an existing one', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nearlink-commit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const part = path.join(root, 'new.part');
  const target = path.join(root, 'report.pdf');
  await fs.writeFile(part, 'new');
  await security.commitFile(part, target);
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
  await fs.rm(part); // a hard link shares its contents with the target
  await fs.writeFile(part, 'newer');
  await assert.rejects(security.commitFile(part, target), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
});
