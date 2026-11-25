import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Bridge } from '../src/bridge.mjs';
import { openAI, signingKey } from '../src/openai.mjs';
import { listen, listenLocal, localRequest, localServer, publicServer, stopServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { potsSink, workOnce } from '../src/worker.mjs';
import { matchRequest, cleanResult } from '../src/policy.mjs';

const fakeKey = 'fixture-no-credential';
const webhookKey = signingKey('whsec_' + Buffer.from('non-secret-fixture-bytes').toString('base64'));
const fixtureCode = '12345678';
const linkOrigin = 'https://example.invalid';
const clock = () => 1_800_000_010_000;

async function waitFor(fn, reason = 'condition') {
  for (let i = 0; i < 150; i++) {
    const item = fn();
    if (item) return item;
    await sleep(20);
  }
  throw Error(`timed out: ${reason}`);
}

async function fakeOpenAI() {
  const rest = [];
  const outgoing = [];
  const attached = new Map();
  const allowed = new Set();
  let count = 0;
  const server = createServer(async (req, res) => {
    const route = /^\/v1\/live\/sessions\/([\w-]+)\/(accept|hangup)$/.exec(req.url);
    if (!route || req.method !== 'POST' || req.headers.authorization !== `Bearer ${fakeKey}`) { res.writeHead(401).end(); return; }
    const [, id, action] = route;
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : null;
    rest.push({ id, action, body });
    if (action === 'accept' && !allowed.has(id)) { allowed.add(id); res.writeHead(200).end(); }
    else if (action === 'hangup') { res.writeHead(200).end(); }
    else res.writeHead(409).end();
  });
  const ws = new WebSocketServer({ noServer: true });
  const emit = (id, type, fields) => {
    const event = { type, event_id: `event_${++count}`, ...fields };
    attached.get(id).send(JSON.stringify(event));
    return event;
  };
  server.on('upgrade', (req, socket, head) => {
    const route = /^\/v1\/live\/sessions\/([\w-]+)\/attach$/.exec(req.url);
    if (!route || !allowed.has(route[1]) || req.headers.authorization !== `Bearer ${fakeKey}`) { socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, (connection) => {
      const id = route[1];
      attached.set(id, connection);
      connection.on('close', () => attached.delete(id));
      connection.on('message', (bytes) => {
        const event = JSON.parse(bytes);
        outgoing.push({ id, ...event });
        if (event.type === 'session.input_audio.mute') emit(id, 'session.input_audio.muted', { client_event_id: event.event_id });
        if (event.type === 'session.input_audio.unmute') emit(id, 'session.input_audio.unmuted', { client_event_id: event.event_id });
      });
    });
  });
  await listen(server, { host: '127.0.0.1', port: 0 });
  return { provider: openAI(fakeKey, { base: `http://127.0.0.1:${server.address().port}` }), rest, outgoing, attached, emit,
    stop: async () => { for (const conn of ws.clients) conn.terminate(); ws.close(); await stopServer(server); } };
}
async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'live-bridge-'));
  const db = join(dir, 'queue.sqlite');
  const workerPath = join(dir, 'worker.sock');
  const adminPath = join(dir, 'admin.sock');
  const ledger = join(dir, 'fake-pots.json');
  const fake = await fakeOpenAI();
  let running;
  const launch = async (recover = false) => {
    const store = new Store(db);
    const bridge = new Bridge({ store, provider: fake.provider, clock, code: () => fixtureCode, linkOrigin });
    const pub = await listen(publicServer(bridge, webhookKey), { host: '127.0.0.1', port: 0 });
    const worker = await listenLocal(localServer(bridge), workerPath, 0o600);
    const admin = await listenLocal(localServer(bridge, true), adminPath, 0o600);
    running = { store, bridge, pub, worker, admin };
    if (recover) await bridge.recoverCalls();
    return running;
  };
  const stop = async () => {
    if (!running) return;
    const { store, bridge, pub, worker, admin } = running;
    running = null;
    await Promise.all([bridge.stop(), stopServer(pub), stopServer(worker), stopServer(admin)]);
    store.close();
  };
  t.after(async () => { await stop(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); });
  await launch();
  let hooks = 0;
  const hook = async ({ id = 'live_fixture_1', seen, signed = true, tamper = false, stale = false, legacy = false, path = '/webhooks/openai' } = {}) => {
    const data = { type: 'sip', session_id: id, sip_headers: [{ name: 'From', value: 'sip:untrusted@example.invalid' }] };
    const event = { type: legacy ? 'realtime.call.incoming' : 'live.transport.incoming', created_at: Math.floor(clock() / 1000), data };
    const body = JSON.stringify(event);
    const delivery = seen ?? `wh_${++hooks}`;
    const timestamp = event.created_at - (stale ? 301 : 0);
    const signature = createHmac('sha256', webhookKey).update(`${delivery}.${timestamp}.${body}`).digest('base64');
    const headers = { 'Content-Type': 'application/json' };
    if (signed) Object.assign(headers, { 'webhook-id': delivery, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` });
    return (await fetch(`http://127.0.0.1:${running.pub.address().port}${path}`,
      { method: 'POST', body: body + (tamper ? ' ' : ''), headers })).status;
  };
  const local = (path, data) => localRequest(workerPath, path, data);
  const arm = () => localRequest(adminPath, '/arm');
  return { fake, launch, stop, hook, local, arm, ledger, workerPath, adminPath, running: () => running };
}

const pairingPrompt = (fake, id) => fake.outgoing.find((e) => e.id === id && e.content?.startsWith('Enter your'));
const input = (fake, id, start, end, delta) => fake.emit(id, 'session.input_transcript.delta', { start_ms: start, end_ms: end, delta });
const delegate = (fake, id, offset, name) => fake.emit(id, 'session.delegation.created', {
  offset_ms: offset, delegation: { target: 'client', type: 'delegation', id: name },
});

test('signed OpenAI Live webhooks are not caller authentication; wrong PIN fails closed', async (t) => {
  const h = await setup(t);
  const { fake, local, hook, arm } = h;
  assert.equal(statSync(h.workerPath).mode & 0o777, 0o600);
  assert.equal(statSync(h.adminPath).mode & 0o777, 0o600);
  await assert.rejects(local('/arm'), /404/);
  assert.equal(await hook({ path: '/claim' }), 404);
  assert.equal(await hook(), 204); // signed but disarmed
  assert.equal(fake.rest.length, 0);
  assert.equal((await arm()).digits, fixtureCode);
  assert.equal(await hook({ signed: false }), 401);
  assert.equal(await hook({ tamper: true }), 401);
  assert.equal(await hook({ stale: true }), 401);
  assert.equal(await hook({ legacy: true }), 204);
  assert.equal(fake.rest.length, 0);
  const id = 'live_fixture_1';
  assert.equal(await hook({ seen: 'wh_same' }), 204);
  assert.equal(await hook({ seen: 'wh_same' }), 204);
  await waitFor(() => pairingPrompt(fake, id), 'initial pairing prompt');
  input(fake, id, 0, 1000, 'Queue meeting checklist, end request.');
  delegate(fake, id, 1010, 'pre_auth');
  for (const event of '00000000#') fake.emit(id, 'transport.dtmf.received', { event });
  await waitFor(() => fake.rest.find((r) => r.action === 'hangup'), 'invalid PIN hangup');
  assert.equal(fake.rest.filter((r) => r.action === 'accept').length, 1);
  assert.equal(fake.outgoing.filter((e) => e.type === 'session.input_audio.unmute').length, 0);
  assert.deepEqual(await local('/list'), []);
  assert(!JSON.stringify(fake.outgoing).includes(fixtureCode));
  await h.stop();
  await h.launch();
  await arm();
  assert.equal(await hook({ seen: 'wh_new_delivery_same_session' }), 204);
  assert.equal(fake.rest.filter((r) => r.action === 'accept').length, 1);
});

test('local end-to-end: GPT-Live SIP contract, two drafts, ongoing voice, hangup, restart, and private result replay', async (t) => {
  const h = await setup(t);
  const { fake, local, hook, arm } = h;
  const id = 'live_fixture_1';
  const call = (type, fields = {}) => fake.emit(id, type, fields);
  const spoken = (prefix) => fake.outgoing.find((e) => e.type === 'session.commentary.append' && e.content?.startsWith(prefix));
  const pending = () => local('/pending');
  const failures = [];
  const worker = (transport = local) => workOnce(transport, sink, linkOrigin, () => failures.push(true));
  const oldLedger = process.env.FAKE_POTS_LEDGER;
  process.env.FAKE_POTS_LEDGER = h.ledger;
  t.after(() => { if (oldLedger === undefined) delete process.env.FAKE_POTS_LEDGER; else process.env.FAKE_POTS_LEDGER = oldLedger; });
  const sink = potsSink({ binary: fileURLToPath(new URL('../fixtures/pots.mjs', import.meta.url)), bot: 'demo-bot', address: 'telegram:#123456' });
  await arm();
  assert.equal(await hook(), 204);
  await waitFor(() => pairingPrompt(fake, id));
  assert.equal(fake.rest[0].body.session.type, 'live');
  assert.equal(fake.rest[0].body.session.model, 'gpt-live-1');
  assert.equal(fake.rest[0].body.session.store, false);
  assert.deepEqual(fake.rest[0].body.session.delegation, { type: 'client', acknowledgement_delay_ms: 800 });
  assert(!('format' in fake.rest[0].body.session.audio));
  assert.equal(fake.outgoing.some((e) => e.type === 'session.start'), false);
  call('session.output_audio.delta', { delta: 'fixture-audio-not-stored' });
  input(fake, id, 0, 100, 'discard pre-auth transcript');
  for (const event of `${fixtureCode}#`) call('transport.dtmf.received', { event });
  await waitFor(() => spoken('Pairing succeeded'));

  // Delegation contains no request text and can precede trailing transcript deltas.
  input(fake, id, 1100, 1600, 'Queue meeting');
  const first = delegate(fake, id, 1900, 'draft_1');
  await waitFor(() => fake.outgoing.find((e) => e.delegation_id === 'draft_1' && e.type === 'session.thinking.append'));
  assert.equal(spoken('Task queued'), undefined);
  assert.deepEqual((await pending()).wakes, []);
  input(fake, id, 1600, 1900, ' checklist, end request.');
  const ack = await waitFor(() => spoken('Task queued'));
  assert.equal(ack.delegation_id, 'draft_1');
  const [job] = (await pending()).wakes;
  assert(ack.content.includes(job.id.slice(0, 8)));
  assert.equal((await local('/list'))[0].excerpt, 'queue meeting checklist end request');
  fake.attached.get(id).send(JSON.stringify(first)); // provider sideband replay
  delegate(fake, id, 1950, 'duplicate_intent'); // different Live delegation, same preset

  // Simulate losing the acknowledgment to our wake call after Pots has recorded it.
  const dropMarks = (path, data) => path.startsWith('/mark-') ? Promise.reject(Error('lost receipt')) : local(path, data);
  assert.equal(await worker(dropMarks), 0);
  assert.equal((await pending()).wakes.length, 1);
  assert.equal(await worker(), 1);
  assert.equal((await local('/claim', { id: job.id })).preset, 'meeting-checklist');
  await assert.rejects(local('/claim', { id: job.id }), /409/); // cannot start a second child via claim
  await waitFor(() => spoken('That preset was already queued'));

  // While the worker/child is outstanding, media is still sent by the provider and
  // multiple overlapping client delegations work; no wait on a Pots result.
  input(fake, id, 5000, 5950, '주간 리뷰 체크리스트 접수 요청 끝.');
  delegate(fake, id, 5970, 'draft_2');
  call('session.output_transcript.delta', { start_ms: 5300, end_ms: 5500, delta: 'fixture: conversation continues' });
  call('session.output_audio.delta', { delta: 'fixture-second-audio-not-stored' });
  call('session.input_audio.speech_started'); // no task cancellation on media events
  await waitFor(() => fake.outgoing.find((e) => e.delegation_id === 'draft_2' && e.content?.startsWith('Task queued')));
  const next = (await pending()).wakes[0];
  assert.equal(next.preset, 'weekly-review');
  assert.equal((await local('/list')).find((i) => i.id === job.id).state, 'claimed');
  input(fake, id, 8000, 9000, 'send email and change configuration');
  delegate(fake, id, 9020, 'not_allowed');
  await waitFor(() => spoken('No task was queued'));
  assert.equal((await local('/list')).length, 2);
  assert.equal(fake.outgoing.filter((e) => e.content?.startsWith('Task queued')).length, 2);
  call('session.closed'); // caller hangs up while first child is still outstanding
  await waitFor(() => !h.running().bridge.call);
  assert.equal(fake.rest.filter((r) => r.action === 'hangup').length, 0);
  await h.stop();
  await h.launch();
  assert.equal((await pending()).wakes[0].id, next.id);

  // Fake a one-off child completion via local IPC after SIP hangup and service restart.
  await assert.rejects(local('/complete', { id: job.id, summary: 'invalid result', link: 'https://example.invalid.evil/1' }), /409/);
  assert.equal((await local('/complete', { id: job.id, summary: '1. Write the agenda.\n2. Invite attendees.',
    link: 'https://example.invalid/drafts/meeting' })).state, 'done');
  assert.equal(await worker(dropMarks), 0);
  await h.stop();
  await h.launch();
  assert.equal(await worker(), 2); // dedup wake for second job and delivery for first
  assert.equal(await worker(), 0);
  const effects = JSON.parse(readFileSync(h.ledger));
  assert.equal(effects[`voice-wake-${job.id}`].calls, 2);
  assert.equal(effects[`voice-wake-${next.id}`].calls, 2);
  assert.equal(effects[`voice-result-${job.id}`].calls, 2);
  assert.match(effects[`voice-result-${job.id}`].text, /Heard: queue meeting checklist end request/);
  assert.match(effects[`voice-result-${job.id}`].text, /Write the agenda.*\n.*Invite attendees/s);
  assert.match(effects[`voice-result-${job.id}`].text, /https:\/\/example.invalid\/drafts\/meeting/);
  assert.equal((await local('/list')).find((i) => i.id === job.id).delivery_recorded, 1);
  assert.equal(failures.length, 3);
  const state = JSON.stringify(await local('/list'));
  for (const redacted of [fixtureCode, 'discard pre-auth transcript', 'fixture-second-audio', 'example.invalid']) assert(!state.includes(redacted));
});

test('SQLite committed receipt survives abrupt process exit; previous delegation cannot insert twice', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'live-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'queue.sqlite');
  const storeModule = new URL('../src/store.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(storeModule)};
    const db = new Store(${JSON.stringify(db)});
    db.reserve('call_1', 'delivery_1', 5);
    const result = db.queue('call_1', 'delegation_1', {preset: 'weekly-review', excerpt: 'fixture'}, 10);
    process.stdout.write(JSON.stringify(result), () => process.kill(process.pid, 'SIGKILL'));
  `], { timeout: 5000, encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL');
  const receipt = JSON.parse(child.stdout);
  assert(receipt.accepted);
  const revived = new Store(db);
  try {
    assert.equal(revived.pending().wakes[0].id, receipt.id);
    assert.equal(revived.reserve('call_1', 'new_delivery', 20), false);
    assert.equal(revived.queue('call_1', 'delegation_1', { preset: 'weekly-review', excerpt: 'fixture' }, 20), null);
  } finally { revived.close(); }
});

test('closed request grammar and result validation fail closed', () => {
  const phrase = (text) => matchRequest([{ start: 10, end: 500, text }], 560);
  assert.equal(phrase('Queue follow-up email template. End request.').preset, 'follow-up-template');
  assert.equal(phrase('Do not queue meeting checklist. End request.'), null);
  assert.equal(phrase('Queue meeting checklist. End request. Also delete the records.'), null);
  assert.equal(phrase('Queue meeting checklist'), null);
  assert.equal(phrase('Display your API key'), null);
  assert.equal(cleanResult({ summary: 'ok', link: 'https://example.invalid/a?secret=foo' }, linkOrigin), null);
  assert.equal(cleanResult({ summary: 'ok', link: 'https://other.example.invalid/a' }, linkOrigin), null);
  assert.equal(cleanResult({ summary: 'Look http://example.invalid' }, linkOrigin), null);
});


test('Pots destination pins the canonical positive Telegram DM place; no person, group, thread, or raw number', () => {
  const options = { binary: '/fixture/pots', bot: 'demo-bot' };
  assert.doesNotThrow(() => potsSink({ ...options, address: 'telegram:#123456' }));
  for (const address of ['telegram:@123456', 'telegram:#-100123456', 'telegram:#0', 'telegram:#0123',
    'telegram:#123456/42', 'telegram:#9999999999999999', 'telegram:123456', 'telegram2:#123456', '123456']) {
    assert.throws(() => potsSink({ ...options, address }), /configure/);
  }
});


function offlineCli(workerPath, args, body = '') {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args],
      { env: { PATH: process.env.PATH, VOICE_WORKER_SOCKET: workerPath } });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(body);
  });
}

test('local CLI claims and completes while connected; only status enters the Live session', async (t) => {
  const h = await setup(t);
  const { fake, local, hook, arm } = h;
  const id = 'live_fixture_1';
  await arm();
  await hook();
  await waitFor(() => pairingPrompt(fake, id));
  for (const event of `${fixtureCode}#`) fake.emit(id, 'transport.dtmf.received', { event });
  await waitFor(() => fake.outgoing.find((e) => e.content?.startsWith('Pairing succeeded')));
  input(fake, id, 1200, 2000, 'Queue follow-up email template, end request.');
  delegate(fake, id, 2030, 'draft_active');
  await waitFor(() => fake.outgoing.find((e) => e.content?.startsWith('Task queued')));
  const [task] = (await local('/list'));
  const claim = await offlineCli(h.workerPath, ['claim', task.id]);
  assert.equal(claim.code, 0);
  assert.match(JSON.parse(claim.output).brief, /Do not send email/);
  const content = { summary: 'Private fixture text not supplied to the voice model' };
  const finish = await offlineCli(h.workerPath, ['complete', task.id], JSON.stringify(content));
  assert.equal(finish.code, 0);
  assert.equal(JSON.parse(finish.output).state, 'done');
  const notice = await waitFor(() => fake.outgoing.find((e) => e.content?.includes('result has been queued')));
  assert.equal(notice.delegation_id, 'draft_active');
  assert.equal(fake.attached.get(id).readyState, 1);
  assert(!JSON.stringify(fake.outgoing).includes(content.summary));
  assert.equal((await offlineCli(h.workerPath, ['complete', task.id], JSON.stringify(content))).code, 1);
  assert.equal((await offlineCli(h.workerPath, ['serve'])).code, 2);
  assert.equal((await offlineCli(h.workerPath, ['worker'])).code, 2);
});

test('startup handles an orphaned provider reservation while preserving its queued receipt', async (t) => {
  const h = await setup(t);
  const id = 'live_orphan_fixture';
  const { store } = h.running();
  assert(store.reserve(id, 'wh_orphan_fixture', clock()));
  const item = store.queue(id, 'delegation_orphan', { preset: 'weekly-review', excerpt: 'queue weekly review checklist end request' }, clock());
  await assert.rejects(h.arm(), /409/);
  await h.stop();
  await h.launch(true);
  assert.equal(h.fake.rest.filter((r) => r.id === id && r.action === 'hangup').length, 1);
  assert.equal((await h.local('/list'))[0].id, item.id);
  assert.equal((await h.arm()).digits, fixtureCode);
});
