const https = require('node:https');
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { lanAddress, fingerprint, pairingCode, safePath, normalizeIP, commitFile } = require('./security.cjs');

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 16384) throw new Error('Request too large.');
  }
  return JSON.parse(data || '{}');
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
class FileServer extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.allowAddress = options.allowAddress || lanAddress;
    this.pending = new Map();
    this.rates = new Map();
    this.locks = new Set();
  }
  async start(port = 0, host = '0.0.0.0') {
    this.server = https.createServer(
      { ...this.store.identity, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' },
      (req, res) => {
        this.handle(req, res).catch(e => {
          if (res.headersSent || res.destroyed) res.destroy();
          else
            send(res, 400, {
              error: e.code === 'ENOENT' ? 'File or shared folder is no longer available.' : e.message,
            });
        });
      },
    );
    this.server.on('connection', socket => {
      if (!this.allowAddress(normalizeIP(socket.remoteAddress))) socket.destroy();
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 10000;
    this.server.setTimeout(30000, socket => socket.destroy());
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolve);
    });
    this.port = this.server.address().port;
    this.cleanup = setInterval(() => {
      const now = Date.now();
      for (const [id, p] of this.pending) if (p.expires < now) this.pending.delete(id);
      for (const [ip, r] of this.rates) if (r.until < now) this.rates.delete(ip);
      this.emit('change');
    }, 5000);
    this.cleanup.unref();
    return this.port;
  }
  pairingRequests() {
    return [...this.pending.values()]
      .filter(p => !p.complete)
      .map(({ id, name, code, localApproved, remoteApproved, expires }) => ({
        id,
        name,
        code,
        localApproved,
        remoteApproved,
        expires,
      }));
  }
  async approve(id) {
    const p = this.pending.get(id);
    if (!p || p.expires < Date.now()) throw new Error('Pairing expired. Start again.');
    p.localApproved = true;
    await this.finish(p);
    this.emit('change');
  }
  reject(id) {
    this.pending.delete(id);
    this.emit('change');
  }
  async finish(p) {
    if (p.localApproved && p.remoteApproved && !p.complete) {
      await this.store.trust({ id: p.deviceId, name: p.name, fingerprint: p.fingerprint });
      p.complete = true;
      this.emit('change');
    }
  }
  async shared(url, write = false) {
    const share = this.store.data.shares.find(s => s.id === url.searchParams.get('share'));
    if (!share) throw new Error('Shared folder is unavailable.');
    if (write && !share.writable) throw new Error('This folder is read-only.');
    const relative = url.searchParams.get('path') || '';
    return { share, relative, file: await safePath(share.path, relative, { allowMissing: write }) };
  }
  async handle(req, res) {
    if (!this.allowAddress(normalizeIP(req.socket.remoteAddress)))
      return send(res, 403, { error: 'Local network only.' });
    const raw = req.socket.getPeerCertificate().raw;
    if (!raw) return send(res, 401, { error: 'A device certificate is required.' });
    const fp = fingerprint(raw);
    const url = new URL(req.url, 'https://nearlink.local');
    if (req.method === 'GET' && url.pathname === '/hello')
      return send(res, 200, {
        id: this.store.data.id,
        name: this.store.data.name,
        version: 1,
        platform: process.platform,
        trustsYou: this.store.data.trusted.some(p => p.fingerprint === fp),
      });
    if (req.method === 'POST' && url.pathname === '/pair/start') {
      const ip = normalizeIP(req.socket.remoteAddress);
      const now = Date.now();
      const r = this.rates.get(ip) || { count: 0, until: now + 60000 };
      if (r.until < now) {
        r.count = 0;
        r.until = now + 60000;
      }
      if (++r.count > 3 || this.pending.size >= 8)
        return send(res, 429, { error: 'Too many pairing requests. Try again in a minute.' });
      this.rates.set(ip, r);
      const input = await body(req);
      if (
        typeof input.id !== 'string' ||
        input.id.length > 100 ||
        typeof input.name !== 'string' ||
        input.name.length > 80 ||
        !/^[a-f0-9]{64}$/.test(input.nonce || '')
      )
        throw new Error('Invalid pairing request.');
      const id = randomUUID();
      const nonce = input.nonce + randomBytes(32).toString('hex');
      const p = {
        id,
        nonce,
        name: input.name,
        deviceId: input.id,
        fingerprint: fp,
        code: pairingCode(fp, this.store.fingerprint, nonce),
        expires: now + 120000,
        localApproved: false,
        remoteApproved: false,
        complete: false,
      };
      this.pending.set(id, p);
      this.emit('change');
      return send(res, 200, { id, nonce, expires: p.expires });
    }
    if (url.pathname.startsWith('/pair/')) {
      const p = this.pending.get(url.searchParams.get('id'));
      if (!p || p.fingerprint !== fp || p.expires < Date.now())
        return send(res, 404, { error: 'Pairing expired or was declined.' });
      if (req.method === 'POST' && url.pathname === '/pair/confirm') {
        await body(req);
        p.remoteApproved = true;
        await this.finish(p);
        this.emit('change');
      } else if (!(req.method === 'GET' && url.pathname === '/pair/status'))
        return send(res, 404, { error: 'Unknown pairing request.' });
      return send(res, 200, { complete: p.complete, approved: p.localApproved });
    }
    if (!this.store.data.trusted.some(p => p.fingerprint === fp))
      return send(res, 401, { error: 'Pair these computers first.' });
    if (req.method === 'GET' && url.pathname === '/shares')
      return send(res, 200, {
        shares: this.store.data.shares.map(({ id, name, writable }) => ({ id, name, writable })),
      });
    if (req.method === 'GET' && url.pathname === '/list') {
      const { file } = await this.shared(url);
      const entries = [];
      for (const dirent of await fs.readdir(file, { withFileTypes: true })) {
        if (
          dirent.isSymbolicLink() ||
          dirent.name.startsWith('.nearlink-') ||
          (!dirent.isFile() && !dirent.isDirectory())
        )
          continue;
        const stat = await fs.lstat(path.join(file, dirent.name));
        entries.push({ name: dirent.name, directory: dirent.isDirectory(), size: stat.size, modified: stat.mtimeMs });
        if (entries.length > 10000) throw new Error('This folder has too many entries. Share a smaller subfolder.');
      }
      return send(res, 200, {
        entries: entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)),
      });
    }
    if (req.method === 'GET' && url.pathname === '/file') {
      const { file } = await this.shared(url);
      const handle = await fs.open(file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Only regular files can be downloaded.');
        // Hash and stream the same open file. A receiver verifies the bytes before committing.
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': stat.size,
          'x-content-sha256': hash.digest('hex'),
        });
        await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), res);
      } finally {
        await handle.close();
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mkdir') {
      await body(req);
      const { file } = await this.shared(url, true);
      await fs.mkdir(file).catch(async e => {
        if (e.code !== 'EEXIST' || !(await fs.lstat(file)).isDirectory()) throw e;
      });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && url.pathname === '/file') {
      const { file, relative, share } = await this.shared(url, true);
      if (!relative) throw new Error('Choose a filename.');
      const expected = req.headers['x-content-sha256'];
      const length = Number(req.headers['content-length']);
      if (!/^[a-f0-9]{64}$/.test(expected || '') || !Number.isSafeInteger(length) || length < 0)
        throw new Error('A file length and checksum are required.');
      if (this.locks.has(file)) throw new Error('Another transfer is writing this file.');
      this.locks.add(file);
      const temporary = path.join(path.dirname(file), '.nearlink-' + randomUUID() + '.part');
      try {
        try {
          await fs.lstat(file);
          throw new Error('A file with this name already exists. Rename it before transferring.');
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        const space = await fs.statfs(path.dirname(file));
        if (space.bavail * space.bsize < length) throw new Error('Not enough disk space.');
        let count = 0;
        const hash = createHash('sha256');
        const verify = new Transform({
          transform(chunk, _, cb) {
            count += chunk.length;
            hash.update(chunk);
            cb(count > length ? new Error('File length exceeded.') : null, chunk);
          },
        });
        await pipeline(req, verify, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if (count !== length || hash.digest('hex') !== expected)
          throw new Error('Checksum mismatch. The source may have changed.');
        await safePath(share.path, relative, { allowMissing: true });
        // A hard link commits without overwriting an existing destination.
        await commitFile(temporary, file);
        return send(res, 200, { ok: true, sha256: expected });
      } finally {
        this.locks.delete(file);
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    }
    if (req.method === 'POST' && url.pathname === '/delete-verified') {
      const input = await body(req);
      const { file, relative } = await this.shared(url, true);
      if (!relative || !/^[a-f0-9]{64}$/.test(input.sha256 || ''))
        throw new Error('A verified file checksum is required.');
      if ((await digest(file)) !== input.sha256) throw new Error('The source changed; it has been kept.');
      await fs.unlink(file);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Unknown operation.' });
  }
  async stop() {
    clearInterval(this.cleanup);
    this.server?.closeAllConnections();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
}
module.exports = { FileServer, digest };
