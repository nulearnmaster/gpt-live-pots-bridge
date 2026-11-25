import { createHmac, timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';

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

// URL and transport substitution are for the in-process local contract test only;
// the CLI never accepts a provider base URL or redirects.
export function openAI(apiKey, { base = 'https://api.openai.com', fetcher = fetch, Socket = WebSocket } = {}) {
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
  return {
    accept: (id) => control(id, 'accept', { session: sessionConfig }),
    hangup: (id) => control(id, 'hangup'),
    attach: (id) => new Socket(url(id, 'attach').replace(/^http/, 'ws'), {
      headers, maxPayload: 256 * 1024, perMessageDeflate: false, handshakeTimeout: 3500, followRedirects: false,
    }),
  };
}
