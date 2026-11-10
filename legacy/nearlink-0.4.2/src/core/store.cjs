const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const selfsigned = require('selfsigned');
const { fingerprint } = require('./security.cjs');

class Store {
  constructor(directory) { this.directory = directory; this.writes = Promise.resolve(); }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.data = JSON.parse(await fs.readFile(path.join(this.directory, 'settings.json'), 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error('Settings could not be read. Restore settings.json instead of resetting your identity.');
      this.data = { version: 1, id: randomUUID(), name: os.hostname().replace(/\.local$/, ''), shares: [], trusted: [] };
    }
    const identityPath = path.join(this.directory, 'identity.json');
    try { this.identity = JSON.parse(await fs.readFile(identityPath, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const pems = await selfsigned.generate([{ name: 'commonName', value: 'Nearlink-' + this.data.id }], { keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 10 * 365 * 86400000) });
      this.identity = { key: pems.private, cert: pems.cert };
      await fs.writeFile(identityPath, JSON.stringify(this.identity), { mode: 0o600, flag: 'wx' });
    }
    await fs.chmod(identityPath, 0o600);
    this.fingerprint = fingerprint(this.identity.cert);
    await this.save();
    return this;
  }
  save() {
    const contents = JSON.stringify(this.data, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      const target = path.join(this.directory, 'settings.json');
      await fs.writeFile(target + '.tmp', contents, { mode: 0o600 });
      await fs.rename(target + '.tmp', target);
    });
    return this.writes;
  }
  async trust(peer) {
    this.data.trusted = this.data.trusted.filter(p => p.id !== peer.id && p.fingerprint !== peer.fingerprint);
    this.data.trusted.push({ id: peer.id, name: peer.name, fingerprint: peer.fingerprint, pairedAt: Date.now() });
    await this.save();
  }
}
module.exports = { Store };
