import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { listen, stopServer } from '../src/server.mjs';

const binary = process.env.VOICE_TEST_CHROMIUM;
async function waitFor(check, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const result = await check();
    if (result) return result;
    await sleep(40);
  }
  throw Error('browser fixture timed out');
}

// Runs in Chromium, not Node. Intercept only the app's local control RPCs.
// Both audio peers are native and get only Chromium's synthetic microphone.
function localPeers() {
  const NativePeer = window.RTCPeerConnection;
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const play = HTMLMediaElement.prototype.play;
  const state = window.fixture = { requests: [], micAttempts: 0, clientData: 0, playAttempts: 0, prepares: 0 };
  Object.defineProperty(document, 'hidden', { get: () => Boolean(state.hidden) });
  navigator.mediaDevices.getUserMedia = async (...args) => {
    state.micAttempts++;
    if (state.rejectMicrophone) throw new DOMException('fixture mic permission', 'NotAllowedError');
    const stream = state.phoneStream = await gum(...args);
    if (state.holdMic) await new Promise((resolve) => { state.releaseMic = resolve; });
    return stream;
  };
  HTMLMediaElement.prototype.play = function () {
    if (this.id === 'audio' && ++state.playAttempts === 1) return Promise.reject(new DOMException('fixture autoplay', 'NotAllowedError'));
    return play.call(this);
  };
  window.RTCPeerConnection = class PhonePeer extends NativePeer {
    constructor() { super(); state.phone = this; }
    async setLocalDescription(description) {
      await super.setLocalDescription(description);
      if (state.holdOffer) await new Promise((resolve) => { state.releaseOffer = resolve; });
    }
  };
  window.fetch = async (path, options) => {
    const body = JSON.parse(options.body);
    state.requests.push([path, body]);
    if (path === '/api/invite' || path === '/api/owner') return new Response(null, { status: 204 });
    if (path === '/api/prepare') {
      if (body.consent !== true) throw Error('missing consent');
      state.permit = String(++state.prepares).padStart(43, 'A');
      return new Response(JSON.stringify({ permit: state.permit }), { status: 200 });
    }
    if (state.permit && body.permit !== state.permit) throw Error('wrong active permit');
    if (path === '/api/lease') return new Response(null, { status: 204 });
    if (path === '/api/end') {
      if (state.events?.readyState === 'open') state.events.send('{"type":"session.closed"}');
      state.remote?.close();
      state.remoteStream?.getTracks().forEach((track) => track.stop());
      return new Response(null, { status: 204 });
    }
    if (path !== '/api/session' || body.consent !== true) throw Error('unexpected request');
    const remote = state.remote = new NativePeer();
    const remoteStream = state.remoteStream = await gum({ audio: true });
    remote.addTrack(remoteStream.getAudioTracks()[0], remoteStream);
    remote.ondatachannel = ({ channel }) => {
      if (channel.label !== 'oai-events') throw Error('wrong channel');
      state.events = channel;
      channel.onmessage = () => state.clientData++;
      channel.onopen = () => channel.send('{"type":"session.started"}');
    };
    await remote.setRemoteDescription({ type: 'offer', sdp: body.sdp });
    await remote.setLocalDescription(await remote.createAnswer());
    if (remote.iceGatheringState !== 'complete') await new Promise((resolve) => {
      remote.addEventListener('icegatheringstatechange', () => { if (remote.iceGatheringState === 'complete') resolve(); });
    });
    return new Response(JSON.stringify({ sdp: remote.localDescription.sdp }), { status: 201 });
  };
}

test('optional Chromium fixture: stable bookmark, consent, hidden-page cancellation, bidirectional RTP and mic cleanup',
  { skip: !binary, timeout: 25_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-chromium-'));
    const child = spawn(binary, ['--headless=new', `--user-data-dir=${dir}`, '--remote-debugging-port=0',
      '--no-proxy-server', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      'about:blank'], { stdio: 'ignore' });
    const processExit = once(child, 'exit');
    // Rejected into the test if the binary cannot be started.
    void processExit.catch(() => {});
    const cleanup = async () => {
      if (child.exitCode === null && child.signalCode === null && child.pid) child.kill();
      await processExit.catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    };
    t.after(cleanup);
    const routes = { '/': ['index.html', 'text/html'], '/voice.mjs': ['voice.mjs', 'text/javascript'], '/voice.css': ['voice.css', 'text/css'] };
    const server = createServer((req, res) => {
      if (!Object.hasOwn(routes, req.url)) { res.writeHead(404).end(); return; }
      const [file, type] = routes[req.url];
      res.writeHead(200, { 'Content-Type': type }).end(readFileSync(new URL(`../web/${file}`, import.meta.url)));
    });
    await listen(server, { host: '127.0.0.1', port: 0 });
    t.after(() => stopServer(server));
    const debugging = await waitFor(() => {
      if (child.exitCode !== null || !child.pid) throw Error('Chromium could not start with its sandbox');
      try { return readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { return null; }
    });
    const targets = await (await fetch(`http://127.0.0.1:${debugging}/json/list`)).json();
    const ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    t.after(() => ws.terminate());
    await once(ws, 'open');
    let next = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const { id, result, error } = JSON.parse(raw);
      if (!pending.has(id)) return;
      const { resolve, reject } = pending.get(id);
      pending.delete(id);
      if (error) reject(Error(error.message)); else resolve(result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const js = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const tap = async (id) => {
      const { x, y } = await js(`(() => { const b = document.querySelector('${id}').getBoundingClientRect(); return {x: b.x+b.width/2, y: b.y+b.height/2}; })()`);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 760, deviceScaleFactor: 2, mobile: true });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `(${localPeers.toString()})();` });
    const navigation = await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/#invite=${'X'.repeat(43)}` });
    assert.equal(navigation.errorText, undefined);
    await waitFor(() => js("!!document.querySelector('#start') && !document.querySelector('#start').disabled"));
    assert.equal(await js('fixture.micAttempts'), 0);
    assert.equal(await js('fixture.requests.map(([path]) => path).join()'), '/api/invite');
    assert.equal(await js('location.hash'), '');
    assert(await js('document.documentElement.scrollWidth <= 360'));
    await js('fixture.rejectMicrophone = true');
    await tap('#start');
    await waitFor(() => js("document.querySelector('#status').textContent.includes('마이크를 허용한 후')"));
    assert.equal(await js('fixture.requests.map(([path]) => path).join()'), '/api/invite');
    await js('fixture.rejectMicrophone = false; fixture.holdMic = true');
    await tap('#start');
    await waitFor(() => js('!!fixture.releaseMic'));
    // Model the browser moving to the background while its permission/media
    // promise is pending. Its eventual stream must still have every track stopped.
    await js("fixture.hidden = true; document.dispatchEvent(new Event('visibilitychange'))");
    assert.equal(await js("document.querySelector('#end').hidden"), true);
    await js('fixture.releaseMic()');
    await waitFor(() => js("fixture.phoneStream.getTracks().every((track) => track.readyState === 'ended')"));
    assert.equal(await js('fixture.requests.map(([path]) => path).join()'), '/api/invite');
    await js("fixture.hidden = false; fixture.holdMic = false; fixture.holdOffer = true; document.dispatchEvent(new Event('visibilitychange'))");
    assert.equal(await js('fixture.micAttempts'), 2); // no automatic restart
    await tap('#start');
    await waitFor(() => js('!!fixture.releaseOffer'));
    // Also check the independent pre-POST gate when the visibility event has
    // not yet been dispatched during ICE/offer handling.
    await js('fixture.hidden = true; fixture.releaseOffer()');
    await waitFor(() => js("fixture.phone.connectionState === 'closed'"));
    assert.equal(await js('fixture.requests.map(([path]) => path).join()'), '/api/invite');
    await js('fixture.hidden = false; fixture.holdOffer = false');
    await tap('#start');
    await waitFor(() => js("document.documentElement.hasAttribute('data-live')"));
    assert.equal(await js('fixture.micAttempts'), 4);
    await waitFor(() => js("!document.querySelector('#play').hidden"));
    await tap('#play');
    await waitFor(() => js("document.querySelector('#play').hidden"));
    await waitFor(() => js(`(async () => {
      const receives = async (peer) => [...(await peer.getStats()).values()].some((m) => m.type === 'inbound-rtp' && m.kind === 'audio' && m.packetsReceived > 0);
      return fixture.phone.getSenders()[0].track.enabled && await receives(fixture.phone) && await receives(fixture.remote);
    })()`));
    assert.equal(await js('fixture.clientData'), 0);
    assert.equal(await js("fixture.requests.filter(([p]) => p === '/api/session').length"), 1);
    await tap('#end');
    await waitFor(() => js("fixture.phone.connectionState === 'closed' && !document.querySelector('#audio').srcObject"));
    assert.equal(await js("document.querySelector('#status').textContent.includes('접수된 작업은 계속')"), true);
    assert(await js("fixture.phoneStream.getTracks().every((track) => track.readyState === 'ended')"));
    assert.equal(await js("fixture.requests.filter(([p]) => p === '/api/end').length"), 1);
    // The bare bookmark opens without a fragment, registration, or cookie.
    await call('Page.reload');
    await waitFor(() => js("!!fixture && fixture.requests[0]?.[0] === '/api/owner' && !document.querySelector('#start').disabled"));
    assert.equal(await js('fixture.micAttempts'), 0);
    assert.equal(await js('fixture.requests.map(([path]) => path).join()'), '/api/owner');
    assert.equal(await js('document.cookie'), '');
    for (let i = 0; i < 2; i++) {
      await tap('#start');
      await waitFor(() => js("document.documentElement.hasAttribute('data-live')"));
      await tap('#end');
      await waitFor(() => js("fixture.phone.connectionState === 'closed' && !document.querySelector('#start').disabled"));
    }
    assert.equal(await js('fixture.micAttempts'), 2);
    assert.deepEqual(await js("fixture.requests.filter(([p]) => p === '/api/session').map(([, body]) => body.consent)"), [true, true]);
    assert.equal(await js("new Set(fixture.requests.filter(([p]) => p === '/api/session').map(([, body]) => body.permit)).size"), 2);
    assert.equal(await js('location.hash'), '');
    assert.equal(await js('document.cookie'), '');
  });
