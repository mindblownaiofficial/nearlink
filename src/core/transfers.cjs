const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');
const { connect, response, readJSON, json } = require('./transport.cjs');
const { safePath, relativeParts, commitFile } = require('./security.cjs');
const { digest } = require('./server.cjs');
const route = (endpoint, share, relative) => `${endpoint}?${new URLSearchParams({ share, path: relative })}`;
const join = (a, b) => (a ? a + '/' + b : b);
class Transfers extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.options = options;
    this.jobs = [];
    this.running = false;
  }
  list() {
    return this.jobs.map(({ run, controller, ...job }) => job);
  }
  add(name, direction, peer, run) {
    if (this.jobs.filter(j => ['queued', 'running'].includes(j.status)).length >= 100)
      throw new Error('The transfer queue is full.');
    const job = {
      id: randomUUID(),
      name,
      direction,
      device: peer.name,
      status: 'queued',
      bytes: 0,
      total: 0,
      files: 0,
      started: 0,
      speed: 0,
      error: '',
      skippedCount: 0,
      skipped: [],
      controller: new AbortController(),
      run,
    };
    this.jobs = this.jobs
      .filter(j => ['queued', 'running'].includes(j.status))
      .concat(this.jobs.filter(j => !['queued', 'running'].includes(j.status)).slice(-49));
    this.jobs.push(job);
    this.emit('change');
    this.pump();
    return job.id;
  }
  cancel(id) {
    const job = this.jobs.find(j => j.id === id);
    if (job && ['queued', 'running'].includes(job.status)) {
      job.controller.abort();
      if (job.status === 'queued') job.status = 'cancelled';
      this.emit('change');
    }
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.jobs) {
        if (job.status !== 'queued') continue;
        job.status = 'running';
        job.started = Date.now();
        this.emit('change');
        try {
          await job.run(job);
          job.status = 'complete';
        } catch (e) {
          job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
          job.error = e.message;
        }
        job.speed = 0;
        this.emit('change');
      }
    } finally {
      this.running = false;
      if (this.jobs.some(j => j.status === 'queued')) this.pump();
    }
  }
  progress(job, count) {
    job.bytes += count;
    job.speed = job.bytes / Math.max(1, (Date.now() - job.started) / 1000);
    if (!job.updated || Date.now() - job.updated > 150) {
      job.updated = Date.now();
      this.emit('change');
    }
  }
  optionsFor(job) {
    return { ...this.options, signal: job.controller.signal };
  }
  upload(peer, share, remoteFolder, localPaths, move = false) {
    return this.add(
      localPaths.length === 1 ? path.basename(localPaths[0]) : `${localPaths.length} items`,
      move ? 'Move to' : 'Send to',
      peer,
      async job => {
        const manifest = [];
        let visited = 0;
        const visit = async (file, relative, depth = 0) => {
          job.controller.signal.throwIfAborted();
          relativeParts(relative);
          if (depth > 64 || ++visited > 100000) throw new Error('Folder is too large or deeply nested.');
          const stat = await fs.lstat(file);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
            const reason = stat.isSymbolicLink() ? 'Symbolic link' : 'Special file';
            if (depth === 0 || move) throw new Error(reason + ' cannot be transferred: ' + file);
            job.skippedCount++;
            if (job.skipped.length < 100) job.skipped.push({ path: relative, reason });
            return;
          }
          if (move && stat.isDirectory()) throw new Error('Move supports individual files. Copy folders first.');
          manifest.push({ file, relative, directory: stat.isDirectory(), size: stat.size });
          if (stat.isDirectory())
            for (const child of await fs.readdir(file))
              await visit(path.join(file, child), join(relative, child), depth + 1);
          else job.total += stat.size;
        };
        for (const file of localPaths) await visit(file, join(remoteFolder, path.basename(file)));
        for (const entry of manifest) {
          job.controller.signal.throwIfAborted();
          if (entry.directory) {
            await json(this.store, peer, route('/mkdir', share, entry.relative), {}, this.optionsFor(job));
            continue;
          }
          const sha256 = await digest(entry.file);
          const stat = await fs.stat(entry.file);
          if (stat.size !== entry.size)
            throw new Error('The source changed. Try again once it is no longer being edited.');
          const req = await connect(this.store, peer, route('/file', share, entry.relative), {
            ...this.optionsFor(job),
            method: 'PUT',
            headers: {
              'content-length': stat.size,
              'x-content-sha256': sha256,
              'content-type': 'application/octet-stream',
            },
          });
          const result = new Promise((resolve, reject) => {
            req.once('response', res => readJSON(res).then(resolve, reject));
            req.once('error', reject);
          });
          // Consume errors immediately while the upload stream is still active.
          result.catch(() => {});
          const meter = new Transform({
            transform: (chunk, _, cb) => {
              this.progress(job, chunk.length);
              cb(null, chunk);
            },
          });
          await pipeline(createReadStream(entry.file), meter, req, { signal: job.controller.signal });
          const reply = await result;
          if (reply.sha256 !== sha256) throw new Error('Destination did not confirm the file checksum.');
          job.files++;
          if (move) {
            if ((await digest(entry.file)) !== sha256)
              throw new Error('Copied successfully, but the source changed and was kept.');
            await fs.unlink(entry.file);
          }
        }
      },
    );
  }
  download(peer, share, remotePaths, destination, move = false) {
    return this.add(
      remotePaths.length === 1 ? path.posix.basename(remotePaths[0]) : `${remotePaths.length} items`,
      move ? 'Move from' : 'Receive from',
      peer,
      async job => {
        const manifest = [];
        const visit = async (remote, local, depth = 0) => {
          job.controller.signal.throwIfAborted();
          relativeParts(remote);
          relativeParts(local);
          if (depth > 64 || manifest.length > 100000) throw new Error('Folder is too large or deeply nested.');
          const parent = path.posix.dirname(remote) === '.' ? '' : path.posix.dirname(remote);
          const { entries } = await json(
            this.store,
            peer,
            route('/list', share, parent),
            undefined,
            this.optionsFor(job),
          );
          const entry = entries.find(e => e.name === path.posix.basename(remote));
          if (!entry) throw new Error('Source file is no longer available.');
          if (move && entry.directory) throw new Error('Move supports individual files. Copy folders first.');
          manifest.push({ remote, local, ...entry });
          if (entry.directory) {
            const children = await json(
              this.store,
              peer,
              route('/list', share, remote),
              undefined,
              this.optionsFor(job),
            );
            for (const child of children.entries)
              await visit(join(remote, child.name), join(local, child.name), depth + 1);
          } else job.total += entry.size;
        };
        for (const remote of remotePaths) await visit(remote, path.posix.basename(remote));
        for (const entry of manifest) {
          job.controller.signal.throwIfAborted();
          const target = await safePath(destination, entry.local, { allowMissing: true });
          if (entry.directory) {
            await fs.mkdir(target).catch(async e => {
              if (e.code !== 'EEXIST' || !(await fs.lstat(target)).isDirectory()) throw e;
            });
            continue;
          }
          try {
            await fs.lstat(target);
            throw new Error(`“${entry.name}” already exists. Choose a different destination.`);
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
          const space = await fs.statfs(path.dirname(target));
          if (space.bavail * space.bsize < entry.size) throw new Error('Not enough disk space.');
          const req = await connect(this.store, peer, route('/file', share, entry.remote), this.optionsFor(job));
          const res = await response(req);
          if (res.statusCode !== 200) {
            await readJSON(res);
            throw new Error('Download failed.');
          }
          const expected = res.headers['x-content-sha256'];
          if (!/^[a-f0-9]{64}$/.test(expected || '')) {
            res.destroy();
            throw new Error('Missing file verification.');
          }
          const temporary = path.join(path.dirname(target), '.nearlink-' + randomUUID() + '.part');
          let count = 0;
          const hash = createHash('sha256');
          const verify = new Transform({
            transform: (chunk, _, cb) => {
              count += chunk.length;
              hash.update(chunk);
              this.progress(job, chunk.length);
              cb(null, chunk);
            },
          });
          try {
            await pipeline(res, verify, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), {
              signal: job.controller.signal,
            });
            if (hash.digest('hex') !== expected || count !== Number(res.headers['content-length']))
              throw new Error('Checksum mismatch. The source may have changed.');
            await safePath(destination, entry.local, { allowMissing: true });
            await commitFile(temporary, target);
            job.files++;
            if (move)
              await json(
                this.store,
                peer,
                route('/delete-verified', share, entry.remote),
                { sha256: expected },
                this.optionsFor(job),
              );
          } finally {
            await fs.rm(temporary, { force: true }).catch(() => {});
          }
        }
      },
    );
  }
}
module.exports = { Transfers, route };
