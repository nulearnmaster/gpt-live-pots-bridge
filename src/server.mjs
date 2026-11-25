import { createServer, request } from 'node:http';
import { chmodSync, lstatSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { verifyHook } from './openai.mjs';
import { receiptPattern } from './policy.mjs';

function reply(res, status, body) {
  if (res.destroyed) return;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  res.writeHead(status, headers);
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function listener(handler, limit = 20 * 1024) {
  const server = createServer({ requestTimeout: 5000, headersTimeout: 3000,
    connectionsCheckingInterval: 1000, maxHeaderSize: 8192 }, async (req, res) => {
    try {
      if (req.method !== 'POST') { reply(res, 405); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) {
        reply(res, 415); return;
      }
      const pieces = [];
      let bytes = 0;
      const timer = setTimeout(() => req.destroy(), 3000);
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > limit) { req.destroy(); return; }
          pieces.push(chunk);
        }
      } finally { clearTimeout(timer); }
      handler(req, res, Buffer.concat(pieces, bytes));
    } catch {
      reply(res, 503);
    }
  });
  server.maxConnections = 24;
  server.keepAliveTimeout = 1000;
  return server;
}
function json(raw) {
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

export function publicServer(bridge, key) {
  return listener((req, res, raw) => {
    if (req.url !== '/webhooks/openai') { reply(res, 404); return; }
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      if (req.headersDistinct[name]?.length !== 1) { reply(res, 401); return; }
    }
    const delivery = verifyHook(key, req.headers, raw, bridge.clock());
    if (!delivery) { reply(res, 401); return; }
    const event = json(raw);
    if (!event) { reply(res, 400); return; }
    bridge.inbound(event, delivery);
    reply(res, 204);
  });
}

export function localServer(bridge, admin = false) {
  return listener((req, res, raw) => {
    const data = json(raw);
    if (!data) { reply(res, 400); return; }
    const { store } = bridge;
    let result;
    if (admin) {
      if (req.url === '/arm') result = bridge.arm();
      else if (req.url === '/invite-web') result = bridge.inviteWeb();
      else { reply(res, 404); return; }
    } else {
      if (['/claim', '/complete', '/fail', '/mark-wake', '/mark-delivery'].includes(req.url) &&
          (typeof data.id !== 'string' || !receiptPattern.test(data.id))) { reply(res, 400); return; }
      switch (req.url) {
        case '/claim': result = store.claim(data.id); break;
        case '/complete': result = bridge.finished(data, false); break;
        case '/fail': result = bridge.finished(data, true); break;
        case '/list': result = store.list(); break;
        case '/pending': result = store.pending(); break;
        case '/mark-wake': result = store.markWake(data.id); break;
        case '/mark-delivery': result = store.markDelivery(data.id); break;
        default: reply(res, 404); return;
      }
    }
    if (result === null || result === false) { reply(res, 409); return; }
    reply(res, 200, result);
  }, 8192);
}

export function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, () => { server.off('error', reject); resolve(server); });
  });
}

export function requirePrivateDirectory(path, privateOnly = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error('use absolute configured paths');
  const dir = lstatSync(dirname(path));
  if (!dir.isDirectory() || dir.uid !== process.getuid() || dir.mode & (privateOnly ? 0o077 : 0o022)) {
    throw Error('use a dedicated non-writable-by-others directory');
  }
}
export async function listenLocal(server, path, mode) {
  requirePrivateDirectory(path);
  // Do not unlink an existing socket; an operator can clean stale sockets after
  // verifying no listener owns them. The CLI runs with umask 0077.
  await listen(server, { path });
  try { chmodSync(path, mode); } catch (e) { server.close(); throw e; }
  return server;
}
export function stopServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export function localRequest(socketPath, path, data = {}) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw Error('configure an absolute socket path');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = request({ socketPath, path, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(Error(`local bridge returned ${res.statusCode}`)); return; }
      const pieces = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > 200 * 1024) req.destroy(Error('local response too large'));
        else pieces.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(pieces))); } catch (error) { reject(error); }
      });
    });
    const timeout = setTimeout(() => req.destroy(Error('local request timed out')), 4000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', reject);
    req.end(body);
  });
}
