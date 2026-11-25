import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { Bridge } from '../src/bridge.mjs';
import { openAI } from '../src/openai.mjs';
import { listen, listenLocal, localRequest, localServer, stopServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { trustedOwnerConfig, webServer } from '../src/web.mjs';
import { potsSink, workOnce } from '../src/worker.mjs';

const origin = 'https://owner.example.invalid';
const key = 'fixture-unusable-key';
const ownerHeaders = { 'X-Voice-Owner': 'owner@example.invalid', 'X-Voice-Proxy-Key': 'A'.repeat(43) };
const fixtureGate = trustedOwnerConfig(ownerHeaders['X-Voice-Owner'], ownerHeaders['X-Voice-Proxy-Key']);
// Structural SDP only; intentionally no real microphone, ICE or audio peer.
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const answer = `${sdp}a=setup:active\r\n`;
async function waitFor(fn) {
  for (let i = 0; i < 150; i++) {
    const result = await fn();
    if (result) return result;
    await sleep(15);
  }
  throw Error('fixture event timed out');
}
async function fakeLive() {
  const state = { requests: [], events: [], attached: new Map() };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${key}` || req.method !== 'POST' || req.url !== '/v1/live/sessions') {
      res.writeHead(404).end(); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    state.requests.push(input);
    if (state.delay) await state.delay;
    const code = state.code ?? 201;
    const id = `live_web_${state.requests.length}`;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id }, secret: 'never-forward-fixture-field', transport: {
      type: 'webrtc', sdp: state.invalidAnswer ? 'invalid-answer' : answer,
    } }));
  });
  const ws = new WebSocketServer({ noServer: true });
  let sequence = 0;
  state.emit = (id, type, fields = {}) => {
    const event = { type, event_id: `evt_${++sequence}`, ...fields };
    state.attached.get(id).send(JSON.stringify(event));
    return event;
  };
  server.on('upgrade', (req, socket, head) => {
    const match = /^\/v1\/live\/sessions\/(live_web_\w+)\/attach$/.exec(req.url);
    if (!match || req.headers.authorization !== `Bearer ${key}`) { socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, (conn) => {
      const [, id] = match;
      state.attached.set(id, conn);
      conn.on('message', (raw) => {
        const event = JSON.parse(raw);
        state.events.push({ id, ...event });
        if (event.type === 'session.close') {
          if (state.dropCloseAck) {
            state.emit(id, 'session.closed', { session: { id: 'different_session' } });
            conn.close();
          } else state.emit(id, 'session.closed', { session: { id } });
        }
      });
      conn.on('close', () => { if (state.attached.get(id) === conn) state.attached.delete(id); });
    });
  });
  await listen(server, { host: '127.0.0.1', port: 0 });
  state.provider = openAI(key, { base: `http://127.0.0.1:${server.address().port}` });
  state.stop = async () => { for (const conn of ws.clients) conn.terminate(); ws.close(); await stopServer(server); };
  return state;
}

async function setup(t, { legacy = false, owner = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'web-bridge-'));
  const dbPath = join(dir, 'queue.sqlite');
  const workerPath = join(dir, 'worker.sock');
  const adminPath = join(dir, 'admin.sock');
  const ledgerPath = join(dir, 'pots.json');
  let now = 1_800_000_000_000;
  if (legacy) {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE calls (session TEXT PRIMARY KEY, delivery TEXT NOT NULL UNIQUE, created INTEGER NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0) STRICT; INSERT INTO calls VALUES ('old_sip', 'old_delivery', 1, 1);`);
    db.close();
    const { chmodSync } = await import('node:fs');
    chmodSync(dbPath, 0o600);
  }
  const fake = await fakeLive();
  let running;
  async function launch(recover = false) {
    const store = new Store(dbPath);
    const bridge = new Bridge({ store, provider: fake.provider, webOrigin: origin, trustedWebOwner: owner, clock: () => now });
    const web = await listen(webServer(bridge, owner ? fixtureGate : null), { host: '127.0.0.1', port: 0 });
    const worker = await listenLocal(localServer(bridge), workerPath, 0o600);
    const admin = await listenLocal(localServer(bridge, true), adminPath, 0o600);
    running = { store, bridge, web, worker, admin };
    if (recover) await bridge.recoverCalls();
    return running;
  }
  async function stop() {
    if (!running) return;
    const { store, bridge, web, worker, admin } = running;
    running = null;
    await Promise.all([bridge.stop(), ...[web, worker, admin].map(stopServer)]);
    store.close();
  }
  t.after(async () => { await stop(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); });
  await launch();
  const web = (path, { data = {}, method = 'POST', headers = {} } = {}) => new Promise((resolve, reject) => {
    const body = method === 'POST' ? JSON.stringify(data) : '';
    const req = request({ host: '127.0.0.1', port: running.web.address().port, path, method, agent: false,
      headers: { Host: 'owner.example.invalid', 'X-Forwarded-Proto': 'https', Origin: origin,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
  const local = (path, data) => localRequest(workerPath, path, data);
  const admin = (path) => localRequest(adminPath, path);
  const invite = async () => new URL((await admin('/invite-web')).url).hash.slice(8);
  const redeem = async (value) => {
    const res = await web('/api/invite', { data: { invite: value } });
    assert.equal(res.status, 204);
    assert.match(res.headers['set-cookie'][0], /^__Host-gpt-live=.{43}; Path=\/; Secure; HttpOnly; SameSite=Strict;/);
    return res.headers['set-cookie'][0].split(';')[0];
  };
  const start = (Cookie) => web('/api/session', { headers: { Cookie }, data: { sdp, consent: true } });
  return { web, local, admin, fake, launch, stop, invite, redeem, start, ledgerPath,
    time: (offset) => now += offset, running: () => running };
}

const input = (f, id, start, end, delta) => f.emit(id, 'session.input_transcript.delta', { start_ms: start, end_ms: end, delta });
const delegate = (f, id, offset, name) => f.emit(id, 'session.delegation.created', {
  offset_ms: offset, delegation: { target: 'client', type: 'delegation', id: name },
});

test('web only exposes its own routes; permission, one-use grant, consent, secure origin and request bounds precede paid creation', async (t) => {
  const h = await setup(t, { legacy: true });
  const { web, fake } = h;
  const page = await web('/', { method: 'GET' });
  assert.equal(page.status, 200);
  assert.match(page.body, /비용에 동의하고 시작/);
  assert.match(page.body, /2분 후 종료 시도 · 예상 US\$0\.10/);
  assert.match(page.body, /종료 확인이 지연되면 요금이 추가될 수 있습니다/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const headers of [{ Host: 'wrong.invalid' }, { 'X-Forwarded-Proto': 'http' }, { Origin: 'https://other.invalid' },
    { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await web('/api/session', { headers })).status, 403);
  for (const path of ['/arm', '/claim', '/api/token', '/webhooks/openai', '/api/session?target=elsewhere']) {
    assert.equal((await web(path)).status, 404);
  }
  assert.equal((await web('/api/session', { method: 'OPTIONS' })).status, 405);
  assert.equal((await web('/api/session')).status, 401);
  await assert.rejects(h.local('/invite-web'), /404/);
  const expired = await h.invite();
  h.time(120_001);
  assert.equal((await web('/api/invite', { data: { invite: expired } })).status, 401);
  const invitation = await h.invite();
  await assert.rejects(h.admin('/arm'), /409/);
  const Cookie = await h.redeem(invitation);
  await assert.rejects(h.admin('/arm'), /409/);
  assert.equal((await web('/api/invite', { data: { invite: invitation } })).status, 401);
  for (const data of [{ sdp }, { sdp: `${sdp}m=video 9 UDP/TLS/RTP/SAVPF 111\r\n`, consent: true },
    { sdp, consent: true, session: { model: 'not-allowed' } }, { sdp: 'text', consent: true }]) {
    assert.equal((await web('/api/session', { data, headers: { Cookie } })).status, 400);
  }
  assert.equal((await web('/api/session', { data: { sdp: 'x'.repeat(65 * 1024), consent: true }, headers: { Cookie } })).status, 413);
  assert.equal(fake.requests.length, 0);
  const [first, second] = await Promise.all([h.start(Cookie), h.start(Cookie)]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  assert.deepEqual(JSON.parse([first, second].find((r) => r.status === 201).body), { sdp: answer });
  assert.equal(fake.requests.length, 1);
  assert.equal((await web('/api/end', { headers: { Cookie } })).status, 204);
  assert.equal((await h.start(Cookie)).status, 401);
  const secondCookie = await h.redeem(await h.invite());
  assert.equal((await h.start(secondCookie)).status, 409); // persisted 30s start spacing
  assert.equal((await web('/api/end', { headers: { Cookie: secondCookie } })).status, 204);
  assert.equal(h.running().store.db.prepare("SELECT transport FROM calls WHERE session='old_sip'").get().transport, 'sip');
});

test('local end-to-end: Live WebRTC signaling + sideband, ongoing delegation, end, restart, and same Pots delivery', async (t) => {
  const h = await setup(t);
  const { fake, local } = h;
  const Cookie = await h.redeem(await h.invite());
  const id = 'live_web_1';
  assert.equal((await h.start(Cookie)).status, 201);
  assert.equal((await h.web('/api/lease', { headers: { Cookie } })).status, 204);
  const [create] = fake.requests;
  assert.deepEqual(create.transport, { type: 'webrtc', sdp });
  assert.equal(create.session.type, 'live');
  assert.equal(create.session.model, 'gpt-live-1.1');
  assert.equal(create.session.store, false);
  assert.deepEqual(create.session.audio, { output: { voice: 'marin' } });
  assert.deepEqual(create.session.delegation, { type: 'client', acknowledgement_delay_ms: 800 });
  assert.deepEqual(create.session.client.data_channel.allowed_client_events, []);
  assert.equal(create.session.tools, undefined);
  assert(!JSON.stringify(create.session.input).includes('keypad'));
  const spoken = (name, text) => fake.events.find((e) => e.delegation_id === name && e.content?.startsWith(text));
  input(fake, id, 1000, 1500, 'Queue meeting');
  const replay = delegate(fake, id, 1900, 'job_a');
  await waitFor(() => fake.events.some((e) => e.type === 'session.thinking.append' && e.delegation_id === 'job_a'));
  assert.equal(spoken('job_a', 'Task queued'), undefined);
  assert.deepEqual(await local('/list'), []);
  input(fake, id, 1500, 1900, ' checklist, end request.');
  await waitFor(() => spoken('job_a', 'Task queued'));
  const [first] = (await local('/pending')).wakes;
  assert(spoken('job_a', 'Task queued').content.includes(first.id.slice(0, 8)));
  const previous = process.env.FAKE_POTS_LEDGER;
  process.env.FAKE_POTS_LEDGER = h.ledgerPath;
  t.after(() => { if (previous === undefined) delete process.env.FAKE_POTS_LEDGER; else process.env.FAKE_POTS_LEDGER = previous; });
  const sink = potsSink({ binary: fileURLToPath(new URL('../fixtures/pots.mjs', import.meta.url)),
    bot: 'demo-bot', address: 'telegram:#123456' });
  assert.equal(await workOnce(local, sink), 1);
  assert.equal((await local('/claim', { id: first.id })).preset, 'meeting-checklist');
  // Neither reflected media nor a still-running Pots child gates acceptance.
  fake.emit(id, 'session.output_audio.delta', { delta: 'discarded-reflected-audio' });
  fake.attached.get(id).send(JSON.stringify(replay));
  input(fake, id, 6000, 6900, '주간 리뷰 체크리스트 접수 요청 끝.');
  delegate(fake, id, 6910, 'job_b');
  await waitFor(() => spoken('job_b', 'Task queued'));
  const [second] = (await local('/pending')).wakes;
  assert.equal(second.preset, 'weekly-review');
  input(fake, id, 8500, 9600, 'Send an email to my boss.');
  delegate(fake, id, 9610, 'unauthorized');
  await waitFor(() => spoken('unauthorized', 'No task was queued'));
  assert.equal((await local('/list')).length, 2);
  assert.equal((await h.web('/api/end', { headers: { Cookie } })).status, 204);
  assert.equal(fake.events.filter(({ type }) => type === 'session.close').length, 1);
  assert.equal(fake.events.some(({ type }) => type === 'session.start'), false);
  await h.stop();
  await h.launch(true);
  assert.equal((await local('/pending')).wakes[0].id, second.id);
  assert.equal((await local('/complete', { id: first.id, summary: 'Fixture generic draft' })).state, 'done');
  assert.equal(await workOnce(local, sink), 2);
  assert.equal(await workOnce(local, sink), 0);
  const effects = JSON.parse(readFileSync(h.ledgerPath));
  assert.match(effects[`voice-result-${first.id}`].text, /Fixture generic draft/);
  assert(!JSON.stringify(fake.events).includes('Fixture generic draft'));
});

test('End during creation cannot orphan a known WebRTC session; SDP answer is withheld', async (t) => {
  const h = await setup(t);
  const Cookie = await h.redeem(await h.invite());
  let release;
  h.fake.delay = new Promise((resolve) => { release = resolve; });
  const opening = h.start(Cookie);
  await waitFor(() => h.fake.requests.length);
  const ending = h.web('/api/end', { headers: { Cookie } });
  await waitFor(() => h.running().bridge.call?.phase === 'closed');
  release();
  assert.equal((await opening).status, 503);
  assert.equal((await ending).status, 204);
  assert.equal(h.fake.events.find(({ type }) => type === 'session.close').id, 'live_web_1');
  assert.deepEqual(h.running().store.unclosed(0), []);
});

test('bad answer with known ID is closed by sideband; ambiguous create blocks both transports even after restart', async (t) => {
  const h = await setup(t);
  const auth = async () => h.redeem(await h.invite());
  h.fake.invalidAnswer = true;
  assert.equal((await h.start(await auth())).status, 503);
  assert.equal(h.fake.events.find(({ type }) => type === 'session.close').id, 'live_web_1');
  assert.deepEqual(h.running().store.unclosed(0), []);
  h.time(30_001);
  h.fake.invalidAnswer = false;
  h.fake.code = 500;
  assert.equal((await h.start(await auth())).status, 503);
  assert.equal(h.running().store.unclosed(0)[0].pending, 1);
  await h.stop();
  await h.launch(true);
  h.time(8 * 86400_000);
  h.running().store.purge(h.time(0));
  await assert.rejects(h.invite(), /409/);
  await assert.rejects(h.admin('/arm'), /409/);
  assert.equal(h.fake.requests.length, 2);
});

test('known orphan uses WebRTC sideband on restart; SIP arm and WebRTC invitation cannot overlap', async (t) => {
  const h = await setup(t);
  await h.admin('/arm');
  await assert.rejects(h.invite(), /409/);
  assert(h.running().store.reserveWeb('web_attempt_orphan', h.time(0)));
  assert(h.running().store.bindWeb('web_attempt_orphan', 'live_web_orphan'));
  await h.stop();
  await h.launch(true);
  assert.equal(h.fake.events.find(({ type }) => type === 'session.close').id, 'live_web_orphan');
  assert.deepEqual(h.running().store.unclosed(0), []);
});

test('a WebSocket close is not proof of a Live session close; later confirmed recovery unblocks the slot', async (t) => {
  const h = await setup(t);
  const Cookie = await h.redeem(await h.invite());
  assert.equal((await h.start(Cookie)).status, 201);
  h.fake.dropCloseAck = true;
  assert.equal((await h.web('/api/end', { headers: { Cookie } })).status, 503);
  const [unconfirmed] = h.running().store.unclosed(h.time(0));
  assert.equal(unconfirmed.session, 'live_web_1');
  assert.equal(unconfirmed.pending, 0);
  await assert.rejects(h.invite(), /409/);
  await h.stop();
  h.fake.dropCloseAck = false;
  await h.launch(true);
  assert.deepEqual(h.running().store.unclosed(0), []);
  assert.ok(await h.invite());
});

test('latch a same-session final frame arriving between End and the cleanup listener', async (t) => {
  const h = await setup(t);
  const Cookie = await h.redeem(await h.invite());
  assert.equal((await h.start(Cookie)).status, 201);
  h.fake.dropCloseAck = true; // Only the already-arrived final frame can confirm close.
  const { bridge, store } = h.running();
  const call = bridge.call;
  const ending = bridge.endWeb(Cookie.split('=')[1]);
  assert.equal(call.phase, 'closed');
  // Deliver the provider's final ahead of the async continuation in end().
  call.receive(JSON.stringify({ type: 'session.closed', event_id: 'final_001', session: { id: call.id } }), false);
  assert.equal(await ending, true);
  assert.deepEqual(store.unclosed(0), []);
  assert.equal(h.fake.events.filter(({ type }) => type === 'session.close').length, 0);
  assert.ok(await h.invite());
});

test('trusted bookmark mode denies raw/spoofed loopback on every route and never charges merely opening root', async (t) => {
  const h = await setup(t, { owner: true });
  for (const path of ['/', '/voice.mjs', '/voice.css', '/api/owner', '/api/prepare', '/api/session', '/api/lease', '/api/end']) {
    const method = path.startsWith('/api') ? 'POST' : 'GET';
    assert.equal((await h.web(path, { method })).status, 403);
    assert.equal((await h.web(path, { method, headers: { 'X-Voice-Owner': ownerHeaders['X-Voice-Owner'] } })).status, 403);
  }
  for (const headers of [
    { 'X-Voice-Owner': 'wrong@example.invalid' }, { 'X-Voice-Proxy-Key': 'Z'.repeat(43) },
    { 'X-Voice-Owner': [ownerHeaders['X-Voice-Owner'], ownerHeaders['X-Voice-Owner']] },
    { 'X-Voice-Proxy-Key': [ownerHeaders['X-Voice-Proxy-Key'], ownerHeaders['X-Voice-Proxy-Key']] },
    { Origin: 'https://other.invalid' }, { 'X-Forwarded-Proto': 'http' }, { Host: 'other.invalid' }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await h.web('/api/owner', { headers: { ...ownerHeaders, ...headers } })).status, 403);
  const page = await h.web('/', { method: 'GET', headers: ownerHeaders });
  assert.equal(page.status, 200);
  assert.equal(page.headers['set-cookie'], undefined);
  assert.match(page.body, /비용에 동의하고 시작/);
  assert(!page.body.includes(ownerHeaders['X-Voice-Proxy-Key']));
  const post = (path, data) => h.web(path, { data, headers: ownerHeaders });
  const status = await post('/api/owner', {});
  assert.equal(status.status, 204);
  assert.equal(status.headers['set-cookie'], undefined);
  await assert.rejects(h.admin('/invite-web'), /409/);
  assert.equal((await post('/api/invite', {})).status, 404);
  assert.equal((await post('/api/prepare', { consent: false })).status, 400);
  assert.equal((await post('/api/session', { consent: true, sdp })).status, 400);
  assert.equal((await post('/api/session', { consent: true, sdp, permit: 'Z'.repeat(43) })).status, 409);
  assert.equal(h.fake.requests.length, 0);
});

test('bookmark works on restart without cookies; short permits are consent-bound, scoped, cancellable and single-use', async (t) => {
  const h = await setup(t, { owner: true });
  const post = (path, data) => h.web(path, { data, headers: ownerHeaders });
  const prepare = async () => {
    const response = await post('/api/prepare', { consent: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers['set-cookie'], undefined);
    return JSON.parse(response.body).permit;
  };
  const start = (permit) => post('/api/session', { consent: true, sdp, permit });
  const stale = await prepare();
  assert.equal((await post('/api/end', { permit: stale })).status, 204);
  assert.equal((await start(stale)).status, 409);
  const expired = await prepare();
  h.time(15_001);
  assert.equal((await start(expired)).status, 409);
  const lostOnRestart = await prepare();
  await h.stop();
  await h.launch(true);
  assert.equal((await h.web('/', { method: 'GET', headers: ownerHeaders })).status, 200);
  assert.equal((await post('/api/owner', {})).status, 204);
  assert.equal((await start(lostOnRestart)).status, 409);
  assert.equal(h.fake.requests.length, 0);
  const current = await prepare();
  assert.equal((await post('/api/session', { consent: false, sdp, permit: current })).status, 400);
  const attempts = await Promise.all([start(current), start(current)]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await post('/api/end', { permit: stale })).status, 409);
  assert.equal((await post('/api/lease', { permit: stale })).status, 409);
  assert.equal((await post('/api/lease', { permit: current })).status, 204);
  assert.equal((await post('/api/prepare', { consent: true })).status, 409);
  assert.equal((await post('/api/end', { permit: current })).status, 204);
  const cooldown = await prepare();
  assert.equal((await start(cooldown)).status, 409);
  h.time(30_001);
  await h.admin('/arm');
  assert.equal((await post('/api/prepare', { consent: true })).status, 409);
  h.time(120_001);
  // SIP arm expiry timer normally uses wall time; restart to clear fixture's in-memory arm.
  await h.stop();
  await h.launch(true);
  assert.equal((await start(await prepare())).status, 201);
  assert.equal(h.fake.requests.length, 2);
});
