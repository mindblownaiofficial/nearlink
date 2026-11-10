const https = require('node:https');
const { fingerprint, lanAddress } = require('./security.cjs');

function connect(
  store,
  peer,
  route,
  { method = 'GET', headers = {}, signal, allowAddress = lanAddress, timeoutMs = 30000 } = {},
) {
  return new Promise((resolve, reject) => {
    if (!allowAddress(peer.host)) return reject(new Error('Only computers on your local network are allowed.'));
    if (
      !Number.isInteger(peer.port) ||
      peer.port < 1 ||
      peer.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(peer.fingerprint || '')
    )
      return reject(new Error('Invalid device identity.'));
    const request = https.request({
      hostname: peer.host,
      port: peer.port,
      path: route,
      method,
      headers,
      key: store.identity.key,
      cert: store.identity.cert,
      rejectUnauthorized: false,
      agent: false,
      minVersion: 'TLSv1.3',
      signal,
    });
    const timer = setTimeout(() => request.destroy(new Error('The device did not respond.')), 5000);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
    request.on('socket', socket =>
      socket.once('secureConnect', () => {
        try {
          if (fingerprint(socket.getPeerCertificate().raw) !== peer.fingerprint)
            throw new Error('Device identity changed. Remove its trust and pair again.');
          clearTimeout(timer);
          request.setTimeout(timeoutMs, () => request.destroy(new Error('The transfer connection timed out.')));
          resolve(request);
        } catch (e) {
          request.destroy(e);
        }
      }),
    );
  });
}
async function response(request, body) {
  return new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
    request.end(body);
  });
}
async function readJSON(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Response is too large.');
  }
  const result = JSON.parse(text || '{}');
  if (stream.statusCode >= 400) throw new Error(result.error || `Request failed (${stream.statusCode}).`);
  return result;
}
async function json(store, peer, route, body, options = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  const req = await connect(store, peer, route, {
    ...options,
    method: encoded ? 'POST' : 'GET',
    headers: encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {},
  });
  return readJSON(await response(req, encoded));
}
module.exports = { connect, response, readJSON, json };
