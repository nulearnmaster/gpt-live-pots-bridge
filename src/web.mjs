import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { validSDP } from './openai.mjs';

const cookieName = '__Host-gpt-live';
const cleared = `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
};
const maxBody = 64 * 1024;
const postPaths = ['/api/session', '/api/lease', '/api/end'];
const trustedLoginPattern = /^[A-Za-z0-9._+@-]{1,254}$/;
const proxyKeyPattern = /^[A-Za-z0-9_-]{43}$/;
export function trustedOwnerConfig(login, key) {
  if (typeof login !== 'string' || !trustedLoginPattern.test(login) || typeof key !== 'string' || !proxyKeyPattern.test(key)) {
    throw Error('configure a pinned owner login and 32-byte base64url proxy key');
  }
  return { login, key: Buffer.from(key) };
}
function fromTrustedGate(req, gate) {
  const supplied = req.headers['x-voice-proxy-key'];
  return req.socket.remoteAddress === '127.0.0.1' && req.headersDistinct['x-voice-owner']?.length === 1 &&
    req.headers['x-voice-owner'] === gate.login && req.headersDistinct['x-voice-proxy-key']?.length === 1 &&
    typeof supplied === 'string' && proxyKeyPattern.test(supplied) && timingSafeEqual(Buffer.from(supplied), gate.key);
}

function reply(res, status, body = '', more = {}) {
  if (res.destroyed) return;
  res.writeHead(status, { ...headers, ...more });
  res.end(body);
}
function ownerCookie(req) {
  const entries = req.headers.cookie?.split(';').map((item) => item.trim())
    .filter((item) => item.startsWith(`${cookieName}=`));
  return entries?.length === 1 ? entries[0].slice(cookieName.length + 1) : undefined;
}
// Global (not IP-spoofable), bounded memory buckets. A network ACL and proxy
// limits are still required: an untrusted user on the edge could deny service.
function bucket(burst, millis) {
  let remaining = burst, previous = performance.now();
  return () => {
    const now = performance.now();
    remaining = Math.min(burst, remaining + (now - previous) / millis);
    previous = now;
    if (remaining < 1) return false;
    remaining -= 1;
    return true;
  };
}
async function readBody(req, res, limit) {
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) > limit) { reply(res, 413, '', { Connection: 'close' }); return null; }
  const timer = setTimeout(() => req.destroy(), 2500);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) { req.destroy(); return null; }
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// Only bind this listener to loopback behind an owner-only TLS reverse proxy.
// Origin/Host alone do not authenticate. Default mode uses an invitation and
// scoped cookie; the explicit owner mode trusts only the proven private gate.
// Never co-host other apps under this exact origin.
export function webServer(bridge, gate = null) {
  if (Boolean(gate) !== bridge.trustedWebOwner) throw Error('trusted web gate mode mismatch');
  const { webOrigin } = bridge;
  if (!webOrigin) throw Error('configure web origin');
  const origin = new URL(webOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== webOrigin) throw Error('require a bare HTTPS origin');
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/voice.css', ['voice.css', 'text/css; charset=utf-8']],
    ['/voice.mjs', ['voice.mjs', 'text/javascript; charset=utf-8']],
  ].map(([path, [name, type]]) => [path, { body: readFileSync(new URL(`../web/${name}`, import.meta.url)), type }]));
  const extraPaths = gate ? ['/api/owner', '/api/prepare'] : ['/api/invite'];
  const acceptInvite = bucket(6, 4000);
  const acceptUnauthenticated = bucket(24, 500);
  const acceptAuthorized = bucket(12, 500);
  const server = createServer({ requestTimeout: 5000, headersTimeout: 3000,
    connectionsCheckingInterval: 1000, maxHeaderSize: 8192 }, async (req, res) => {
    try {
      if (req.headersDistinct.host?.length !== 1 || req.headers.host !== origin.host ||
          req.headersDistinct['x-forwarded-proto']?.length !== 1 || req.headers['x-forwarded-proto'] !== 'https') {
        reply(res, 403); return;
      }
      if (gate && !fromTrustedGate(req, gate)) { reply(res, 403); return; }
      if (req.method === 'GET') {
        if (!acceptUnauthenticated()) { reply(res, 429); return; }
        const asset = assets.get(req.url);
        if (!asset) { reply(res, 404); return; }
        reply(res, 200, asset.body, { 'Content-Type': asset.type }); return;
      }
      if (req.method !== 'POST') { reply(res, 405); return; }
      if (!postPaths.includes(req.url) && !extraPaths.includes(req.url)) { reply(res, 404); return; }
      if (req.headersDistinct.origin?.length !== 1 || req.headers.origin !== webOrigin ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        reply(res, 403); return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) {
        reply(res, 415); return;
      }
      const cookie = gate ? undefined : ownerCookie(req);
      if (req.url === '/api/invite') {
        if (!acceptInvite()) { reply(res, 429); return; }
      } else {
        if (!gate && !bridge.hasWebAuth(cookie)) {
          reply(res, acceptUnauthenticated() ? 401 : 429); return;
        }
        // End remains available after legitimate request-bucket exhaustion.
        if (req.url !== '/api/end' && !acceptAuthorized()) { reply(res, 429); return; }
      }
      const data = await readBody(req, res, req.url === '/api/session' ? maxBody : 256);
      if (res.headersSent || res.destroyed) return;
      if (!data) { reply(res, 400); return; }
      const keys = Object.keys(data);
      if (gate) {
        if (req.url === '/api/owner') { reply(res, keys.length ? 400 : 204); return; }
        if (req.url === '/api/prepare') {
          if (keys.length !== 1 || data.consent !== true) { reply(res, 400); return; }
          const permit = bridge.prepareOwnerWeb();
          if (!permit) { reply(res, 409); return; }
          reply(res, 200, JSON.stringify({ permit }), { 'Content-Type': 'application/json' }); return;
        }
        if (typeof data.permit !== 'string' || !proxyKeyPattern.test(data.permit)) { reply(res, 400); return; }
        if (req.url === '/api/lease' || req.url === '/api/end') {
          if (keys.length !== 1) { reply(res, 400); return; }
          if (req.url === '/api/lease') { reply(res, bridge.touchOwnerWeb(data.permit) ? 204 : 409); return; }
          const ended = await bridge.endOwnerWeb(data.permit);
          reply(res, ended === true ? 204 : ended === false ? 503 : 409); return;
        }
      }
      if (req.url === '/api/invite') {
        const grant = keys.length === 1 && bridge.redeemWeb(data.invite);
        if (!grant) { reply(res, 401); return; }
        reply(res, 204, '', { 'Set-Cookie': `${cookieName}=${grant}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=240` });
      } else if (req.url === '/api/session') {
        if (keys.length !== (gate ? 3 : 2) || data.consent !== true || !validSDP(data.sdp)) { reply(res, 400); return; }
        const answer = await (gate ? bridge.startOwnerWeb(data.permit, data.sdp) : bridge.startWeb(cookie, data.sdp));
        if (!answer) { reply(res, 409); return; }
        if (res.destroyed) {
          await (gate ? bridge.endOwnerWeb(data.permit) : bridge.endWeb(cookie));
          return;
        }
        // Do not forward the provider session ID, credentials, headers or JSON.
        reply(res, 201, JSON.stringify({ sdp: answer }), { 'Content-Type': 'application/json' });
      } else {
        if (keys.length) { reply(res, 400); return; }
        if (req.url === '/api/lease') { reply(res, bridge.touchWeb(cookie) ? 204 : 409); return; }
        const ended = await bridge.endWeb(cookie);
        reply(res, ended === true ? 204 : ended === false ? 503 : 401, '', { 'Set-Cookie': cleared });
      }
    } catch {
      reply(res, 503);
    }
  });
  server.maxConnections = 16;
  server.keepAliveTimeout = 1000;
  return server;
}
