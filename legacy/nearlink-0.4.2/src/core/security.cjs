const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const { X509Certificate, createHash } = require('node:crypto');

const normalizeIP = ip => String(ip || '').replace(/^::ffff:/, '');
const ipNumber = ip => ip.split('.').reduce((n, v) => ((n << 8) | Number(v)) >>> 0, 0);
function privateIP(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
function lanAddress(ip, interfaces = os.networkInterfaces()) {
  ip = normalizeIP(ip);
  if (!privateIP(ip)) return false;
  return Object.entries(interfaces).some(([name, entries]) =>
    !/^(utun|tun|tap|tailscale|wg|ppp|ipsec|zt)/i.test(name) && entries.some(i =>
      !i.internal && i.family === 'IPv4' && privateIP(i.address) &&
      ((ipNumber(ip) & ipNumber(i.netmask)) >>> 0) === ((ipNumber(i.address) & ipNumber(i.netmask)) >>> 0)));
}
const fingerprint = cert => new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
function pairingCode(a, b, nonce) {
  return createHash('sha256').update([a, b].sort().join(':') + ':' + nonce).digest('hex').slice(0, 16).toUpperCase().match(/.{4}/g).join(' ');
}
function relativeParts(relative) {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\\') || relative.startsWith('/')) throw new Error('Invalid file path.');
  const parts = relative === '' ? [] : relative.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || /[\x00-\x1f<>:"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || p.startsWith('.nearlink-')) throw new Error('This filename is not safely transferable between Mac and Windows.');
  }
  return parts;
}
async function safePath(root, relative, { allowMissing = false } = {}) {
  const parts = relativeParts(relative);
  const base = await fs.realpath(root);
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not shared.');
      const real = await fs.realpath(current);
      const rel = path.relative(base, real);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path is outside the shared folder.');
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT' && index === parts.length - 1) return current;
      throw error;
    }
  }
  return current;
}
module.exports = { normalizeIP, privateIP, lanAddress, fingerprint, pairingCode, relativeParts, safePath };
