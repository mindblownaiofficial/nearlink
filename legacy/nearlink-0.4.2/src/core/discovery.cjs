const { Bonjour } = require('bonjour-service');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { lanAddress } = require('./security.cjs');
const { json } = require('./transport.cjs');

class Discovery extends EventEmitter {
  constructor(store, port) { super(); this.store = store; this.port = port; this.candidates = new Map(); this.devices = new Map(); this.checking = false; this.failures = new Map(); this.startedAt = Date.now(); }
  start() {
    this.bonjour = new Bonjour({}, error => this.emit('warning', 'Discovery: ' + error.message));
    this.service = this.bonjour.publish({ name: 'Nearlink-' + this.store.data.id, type: 'nearlink', protocol: 'tcp', port: this.port, txt: { id: this.store.data.id, fp: this.store.fingerprint, v: '1' } });
    this.service.on('error', e => this.emit('warning', e.message));
    this.startBrowser();
    this.timer = setInterval(() => { this.browser.update(); this.refresh(); }, 4000);
    this.timer.unref();
  }
  startBrowser() {
    this.browser?.stop();
    this.browser = this.bonjour.find({ type: 'nearlink' });
    this.browser.on('up', service => this.add(service));
    this.browser.on('srv-update', service => this.add(service));
    this.browser.on('txt-update', service => this.add(service));
    this.browser.on('down', service => {
      if (service.txt?.id) { this.candidates.delete(String(service.txt.id)); this.devices.delete(String(service.txt.id)); this.failures.delete(String(service.txt.id)); this.emit('change'); }
    });
  }
  async rescan() {
    this.startBrowser();
    await this.refresh();
  }
  diagnostics() {
    return { addresses: Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal && lanAddress(i.address)).map(i => i.address), port: this.port, candidates: this.candidates.size, failures: [...this.failures.values()], listeningSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }
  add(service) {
    const id = String(service.txt?.id || ''); const fp = String(service.txt?.fp || '');
    if (!/^[a-f0-9-]{36}$/.test(id) || id === this.store.data.id || !/^[a-f0-9]{64}$/.test(fp) || this.candidates.size >= 128 && !this.candidates.has(id)) return;
    const hosts = [...new Set([service.referer?.address, ...(service.addresses || [])].filter(ip => ip && lanAddress(ip)))];
    if (!hosts.length) return;
    const trusted = this.store.data.trusted.find(p => p.id === id);
    if (trusted && trusted.fingerprint !== fp) { this.emit('warning', 'A device advertised a different identity. Pair again only if you reinstalled its app.'); return; }
    this.candidates.set(id, { id, hosts, port: service.port, fingerprint: fp }); this.refresh();
  }
  async refresh() {
    if (this.checking) return;
    this.checking = true;
    try {
      await Promise.all([...this.candidates.values()].map(async candidate => {
        for (const host of candidate.hosts) {
          try {
            const peer = { ...candidate, host };
            const hello = await json(this.store, peer, '/hello', undefined, { timeoutMs: 5000 });
            if (hello.id !== peer.id || hello.version !== 1) throw new Error('Identity mismatch.');
            if (this.candidates.get(peer.id) !== candidate) return;
            this.failures.delete(candidate.id);
            this.devices.set(peer.id, { ...peer, name: String(hello.name).slice(0, 80), platform: hello.platform, trustsYou: hello.trustsYou, lastSeen: Date.now() });
            return;
          } catch (error) {
            this.failures.set(candidate.id, { address: host, message: error.code ? `${error.code}: ${error.message}` : error.message });
          }
        }
        this.devices.delete(candidate.id);
      }));
      this.emit('change');
    } finally { this.checking = false; }
  }
  list() { return [...this.devices.values()].map(peer => ({ ...peer, paired: peer.trustsYou && this.store.data.trusted.some(t => t.id === peer.id && t.fingerprint === peer.fingerprint) })); }
  peer(id) { const p = this.list().find(p => p.id === id); if (!p) throw new Error('This computer is offline.'); return p; }
  async stop() { clearInterval(this.timer); this.browser?.stop(); if (this.bonjour) await new Promise(resolve => this.bonjour.unpublishAll(() => { this.bonjour.destroy(); resolve(); })); }
}
module.exports = { Discovery };
