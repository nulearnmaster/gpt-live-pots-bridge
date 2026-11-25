import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { idPattern } from './policy.mjs';

const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function standardBase64(text) {
  if (typeof text !== 'string' || !text || !base64.test(text)) return null;
  const decoded = Buffer.from(text, 'base64');
  return decoded.toString('base64') === text ? decoded : null;
}
export function signingKey(secret) {
  const key = typeof secret === 'string' && secret.startsWith('whsec_') && standardBase64(secret.slice(6));
  if (!key || key.length < 16) throw Error('invalid webhook signing secret');
  return key;
}
export function verifyHook(key, headers, raw, now) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id) ||
      typeof timestamp !== 'string' || !/^\d{10,12}$/.test(timestamp) ||
      Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 ||
      typeof signatures !== 'string' || signatures.length > 1024) return null;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest();
  return signatures.trim().split(/\s+/).some((item) => {
    const sig = item.startsWith('v1,') && standardBase64(item.slice(3));
    return sig && sig.length === expected.length && timingSafeEqual(expected, sig);
  }) ? id : null;
}

export const sessionConfig = {
  type: 'live', model: 'gpt-live-1', store: false, audio: { output: { voice: 'marin' } },
  delegation: { type: 'client', acknowledgement_delay_ms: 800 },
  instructions: `You are a hands-free assistant. Converse naturally in the caller's language but never claim a task was queued, started or completed without the corresponding server commentary. Do not invent a receipt. Delegate clearly addressed preset commands ending with "end request" or "요청 끝" in client mode. Only the server can authorize tasks. Do not request passwords or spoken pairing codes. This bridge only drafts generic checklists and templates; it does not send emails, execute shell commands, change systems or make purchases. Never repeat a PIN.`,
  input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text',
    text: 'Greet briefly. Say this call is processed by AI; use the keypad (not speech) for pairing and do not say secrets. Then pause.' }] }],
};

const webSessionConfig = {
  ...sessionConfig, model: 'gpt-live-1.1',
  instructions: `${sessionConfig.instructions} Be concise. Default to Korean unless the caller prefers another language.`,
  client: { data_channel: { allowed_client_events: [], allowed_server_events: [
    { type: 'session.started' }, { type: 'session.closed' },
  ] } },
  input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text',
    text: 'Greet briefly and say this conversation uses AI. Do not ask for a PIN or sign-in, and remind the user not to say secrets. Then pause.' }] }],
};

export const webVoices = Object.freeze(['marin', 'coral']);

export const maxSDP = 48 * 1024;
export function validSDP(sdp) {
  if (typeof sdp !== 'string' || !/^v=0\r?\n/.test(sdp) || Buffer.byteLength(sdp) > maxSDP ||
      /[^\x09\x0a\x0d\x20-\x7e]/.test(sdp)) return false;
  const media = [...sdp.matchAll(/^m=([^ ]+) /gm)].map((match) => match[1]);
  return media.length === 2 && media.includes('audio') && media.includes('application');
}

async function boundedJSON(response) {
  const pieces = [];
  let bytes = 0;
  for await (const piece of response.body) {
    bytes += piece.length;
    if (bytes > 128 * 1024) throw Error('oversized Live reply');
    pieces.push(piece);
  }
  return JSON.parse(Buffer.concat(pieces));
}

// Live's REST hangup is SIP-only. Keep listening for session.closed (not
// just WebSocket close); a missing final event is ambiguous.
export function isWebClosed(event, id) {
  return event?.type === 'session.closed' && event.session?.id === id &&
    typeof event.event_id === 'string' && idPattern.test(event.event_id);
}
function closeWebSocket(id, socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => failed(), 5000);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (ok) resolve();
      else reject(Error('WebRTC close not confirmed'));
      socket.terminate();
    };
    const failed = () => finish(false);
    const send = () => {
      try { socket.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() })); }
      catch { failed(); }
    };
    socket.on('error', failed);
    socket.once('close', failed);
    socket.on('message', (bytes, binary) => {
      if (binary) return;
      try { if (isWebClosed(JSON.parse(bytes), id)) finish(true); } catch { /* not a final event */ }
    });
    if (socket.readyState === 1) send();
    else if (socket.readyState === 0) socket.once('open', send);
    else failed();
  });
}

// URL and transport substitution are for the in-process local contract test only;
// the CLI never accepts a provider base URL or redirects.
export function openAI(apiKey, { base = 'https://api.openai.com', fetcher = fetch, Socket = WebSocket, webVoice = 'marin' } = {}) {
  if (!webVoices.includes(webVoice)) throw Error('unsupported Live web voice');
  const url = (id, path) => `${base}/v1/live/sessions/${encodeURIComponent(id)}/${path}`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  async function control(id, action, payload) {
    const response = await fetcher(url(id, action), {
      method: 'POST', headers: payload ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: payload ? JSON.stringify(payload) : undefined, redirect: 'error', signal: AbortSignal.timeout(4000),
    });
    await response.body?.cancel();
    if (response.status !== 200 && !(action === 'hangup' && [404, 410].includes(response.status))) {
      throw Error('call-control failed');
    }
  }
  const attach = (id) => new Socket(url(id, 'attach').replace(/^http/, 'ws'), {
    headers, maxPayload: 256 * 1024, perMessageDeflate: false, handshakeTimeout: 3500, followRedirects: false,
  });
  return {
    accept: (id) => control(id, 'accept', { session: sessionConfig }),
    hangup: (id) => control(id, 'hangup'),
    attach,
    async createWeb(sdp) {
      const response = await fetcher(`${base}/v1/live/sessions`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(8000), body: JSON.stringify({ session: { ...webSessionConfig, audio: { output: { voice: webVoice } } }, transport: { type: 'webrtc', sdp } }),
      });
      if (response.status !== 201) {
        await response.body?.cancel();
        // Do not treat server errors, timeouts or redirects as proof that a
        // session was never created. Never retry a possibly billable create.
        if ([400, 401, 403, 404, 413, 415, 422, 429].includes(response.status)) return { rejected: true };
        throw Error('Live creation outcome unknown');
      }
      const data = await boundedJSON(response);
      const id = data?.session?.id;
      if (typeof id !== 'string' || !idPattern.test(id)) throw Error('invalid Live session ID');
      return { id, sdp: data?.transport?.type === 'webrtc' && validSDP(data.transport.sdp) ? data.transport.sdp : null };
    },
    closeWeb: (id, socket) => closeWebSocket(id, socket?.readyState <= 1 ? socket : attach(id)),
  };
}
