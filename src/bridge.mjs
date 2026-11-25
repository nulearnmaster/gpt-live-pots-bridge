import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { isWebClosed, validSDP } from './openai.mjs';
import { cleanResult, idPattern, matchRequest, receiptPattern } from './policy.mjs';

const armMs = 120_000;
const pairMs = 45_000;
const callMs = 20 * 60_000;
const webLeaseMs = 20_000;
const webCallMs = 115_000; // Leave a bounded grace period within the two-minute pilot.
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const token = () => randomBytes(32).toString('base64url');
const matches = (grant, value) => typeof value === 'string' && tokenPattern.test(value) && grant &&
  timingSafeEqual(hash(grant.key, value), grant.digest);
const verifier = (value, expires) => {
  const key = randomBytes(32);
  return { key, digest: hash(key, value), expires };
};
const hash = (key, digits) => createHmac('sha256', key).update(digits).digest();
const validId = (id) => typeof id === 'string' && idPattern.test(id);
const logFailure = (kind) => process.stderr.write(`voice-bridge: ${kind}\n`);

export class Bridge {
  constructor({ store, provider, linkOrigin = null, webOrigin = null, clock = Date.now, code = () => String(randomInt(1e8)).padStart(8, '0') }) {
    Object.assign(this, { store, provider, linkOrigin, webOrigin, clock, code });
  }
  blocked() {
    return this.call || this.stopped || this.recovering || this.store.unclosed(this.clock()).length;
  }
  arm() {
    if (this.blocked() || this.webGrant?.expires > this.clock() || this.webAuth?.expires > this.clock()) return null;
    const digits = this.code();
    const key = randomBytes(32);
    const issued = this.clock();
    clearTimeout(this.armTimer);
    this.grant = { issued, code: hash(key, digits), key };
    this.armTimer = setTimeout(() => { this.grant = null; }, armMs);
    this.armTimer.unref();
    return { digits, expires_at: issued + armMs };
  }
  inviteWeb() {
    if (!this.webOrigin || this.blocked() || this.grant) return null;
    const value = token();
    const expires = this.clock() + armMs;
    this.webAuth = null;
    this.webGrant = verifier(value, expires);
    return { url: `${this.webOrigin}/#invite=${value}`, expires_at: expires };
  }
  redeemWeb(invitation) {
    if (this.blocked() || !this.webOrigin || this.webGrant?.expires <= this.clock() || !matches(this.webGrant, invitation)) return null;
    this.webGrant = null;
    const value = token();
    this.webAuth = verifier(value, this.clock() + armMs);
    return value;
  }
  hasWebAuth(cookie) {
    return !!(matches(this.webAuth, cookie) && (this.call?.kind === 'webrtc' || this.webAuth.expires > this.clock()));
  }
  async startWeb(cookie, sdp) {
    if (this.blocked() || !this.hasWebAuth(cookie) || !validSDP(sdp)) return null;
    const attempt = `web_${randomUUID()}`;
    if (!this.store.reserveWeb(attempt, this.clock())) return null;
    const call = new WebCall(this, attempt);
    this.call = call;
    return call.start(sdp);
  }
  touchWeb(cookie) {
    if (!this.hasWebAuth(cookie) || this.call?.kind !== 'webrtc' || this.call.phase === 'closed') return false;
    this.call.touch();
    return true;
  }
  async endWeb(cookie) {
    if (!this.hasWebAuth(cookie)) return null;
    if (this.call?.kind === 'webrtc') return !!(await this.call.end(true));
    this.webAuth = null;
    return true;
  }
  async recoverCalls() {
    this.recovering = true;
    try {
      for (const { session: id, transport, pending } of this.store.unclosed(this.clock())) {
        if (this.stopped) break;
        if (!validId(id)) continue;
        try {
          if (transport === 'webrtc') {
            if (pending) throw Error('no provider ID recorded');
            await this.provider.closeWeb(id);
          } else await this.provider.hangup(id);
          this.store.endCall(id);
        } catch { logFailure('previous call cleanup not confirmed; new pairing blocked'); }
      }
    } finally { this.recovering = false; }
  }
  inbound(event, delivery) {
    if (!this.grant || this.call || this.stopped) return;
    const now = this.clock();
    const { type, data, created_at: created } = event;
    if (type !== 'live.transport.incoming' || data?.type !== 'sip' || !validId(data.session_id) ||
        !Number.isSafeInteger(created) || created < Math.floor(this.grant.issued / 1000) ||
        now - created * 1000 > 20_000 || created * 1000 - now > 5_000 || now - this.grant.issued >= armMs) return;
    if (!this.store.reserve(data.session_id, delivery, now)) return;
    // Do not inspect any SIP identity metadata. A signed webhook is not caller authentication.
    this.call = new Call(this, data.session_id, this.grant);
    this.grant = null;
    clearTimeout(this.armTimer);
    this.call.start();
  }
  finished(request, failed) {
    if (!receiptPattern.test(request.id)) return null;
    const result = failed ? { summary: 'The draft did not complete. Contact the operator if you want to retry.', link: null }
      : cleanResult(request, this.linkOrigin);
    if (!result) return null;
    const row = this.store.finish(request.id, result, this.clock(), failed);
    if (row && this.call?.id === row.session && this.call.phase === 'active') {
      const short = row.id.slice(0, 8);
      this.call.append('commentary', row.delegation, failed ? `Draft ${short} failed.`
        : `Draft ${short} is ready. A result has been queued for your configured private inbox.`);
    }
    return row && { id: row.id, state: row.state };
  }
  async stop() {
    this.stopped = true;
    this.grant = this.webGrant = this.webAuth = null;
    clearTimeout(this.armTimer);
    await this.call?.end(true);
  }
}

class Call {
  constructor(bridge, id, grant, timeout = pairMs) {
    Object.assign(this, { bridge, id, grant });
    this.phase = 'connecting';
    this.digits = '';
    this.seen = new Set();
    this.fragments = [];
    this.delegations = new Set();
    this.pending = new Set();
    this.transcriptFloor = 0;
    this.latestUnauthenticatedEnd = 0;
    this.timer = setTimeout(() => this.end(true), timeout);
  }
  async start() {
    const { provider } = this.bridge;
    this.accepting = provider.accept(this.id);
    try {
      await this.accepting;
      if (this.phase === 'closed') return;
      await this.connect(() => {
        this.phase = 'muting';
        this.mute = this.send('session.input_audio.mute');
      });
    } catch {
      if (this.phase !== 'closed') logFailure('call setup failed');
      this.end(true);
    }
  }
  connect(onOpen) {
    this.socket = this.bridge.provider.attach(this.id);
    return new Promise((resolve, reject) => {
      const lost = () => {
        reject(Error('sideband disconnected'));
        this.end(true);
      };
      this.socket.on('message', (bytes, isBinary) => this.receive(bytes, isBinary));
      this.socket.on('error', lost);
      this.socket.on('close', lost);
      this.socket.once('open', () => {
        if (this.phase === 'closed') { reject(Error('call ended')); return; }
        onOpen();
        resolve();
      });
    });
  }
  terminal(type) { this.end(false); }
  send(type, fields = {}) {
    if (this.socket?.readyState !== 1) return null;
    const event_id = randomUUID();
    try { this.socket.send(JSON.stringify({ type, event_id, ...fields })); return event_id; }
    catch { return null; }
  }
  append(kind, delegation_id, content) {
    return this.send(`session.${kind}.append`, { delegation_id, content });
  }
  receive(bytes, isBinary) {
    if (isBinary || (this.phase === 'closed' && this.kind !== 'webrtc')) return;
    let event;
    try { event = JSON.parse(bytes); } catch { return; }
    if (!event || typeof event !== 'object') return;
    const { type, event_id } = event;
    // Final evidence on the existing sideband can follow a transport failure
    // in the same batch. Latch even during close, before any detach/reattach.
    if (type === 'session.closed' && this.kind === 'webrtc') {
      if (isWebClosed(event, this.id)) this.terminal(type);
      return;
    }
    if (this.phase === 'closed' || (this.kind === 'webrtc' && type === 'transport.failed')) return;
    if (!['session.closed', 'transport.failed', 'session.input_audio.muted', 'session.input_audio.unmuted',
      'transport.dtmf.received', 'session.input_transcript.delta', 'session.delegation.created'].includes(type)) return;
    if (!validId(event_id) || this.seen.has(event_id)) return;
    if (this.seen.size >= 32_768) { this.end(true); return; }
    this.seen.add(event_id);
    if (type === 'session.closed' || type === 'transport.failed') { this.terminal(type); return; }
    if (type === 'session.input_audio.muted' && this.phase === 'muting' && event.client_event_id === this.mute) {
      this.phase = 'pairing';
      this.append('commentary', null, 'Enter your eight-digit pairing code on the keypad, followed by pound. Do not say it aloud.');
    } else if (type === 'transport.dtmf.received' && this.phase === 'pairing') {
      this.keypress(event.event);
    } else if (type === 'session.input_audio.unmuted' && this.phase === 'unmuting' && event.client_event_id === this.unmute) {
      this.phase = 'active';
      this.transcriptFloor = this.latestUnauthenticatedEnd;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.end(true), callMs);
      this.append('commentary', null, 'Pairing succeeded. You can talk now. To queue a preset, say for example: Queue meeting checklist, end request.');
    } else if (type === 'session.input_transcript.delta') {
      this.transcript(event);
    } else if (type === 'session.delegation.created' && event.delegation?.target === 'client' && validId(event.delegation.id)) {
      this.delegate(event.delegation.id, event.offset_ms);
    }
  }
  keypress(digit) {
    if (typeof digit !== 'string' || !/^[0-9#]$/.test(digit)) { this.end(true); return; }
    if (digit !== '#') {
      if (this.digits.length === 8) this.end(true);
      else this.digits += digit;
      return;
    }
    const { key, code } = this.grant;
    const verified = this.digits.length === 8 && timingSafeEqual(hash(key, this.digits), code);
    this.grant = null;
    this.digits = '';
    if (!verified) { this.end(true); return; }
    this.phase = 'unmuting';
    this.unmute = this.send('session.input_audio.unmute');
  }
  transcript({ start_ms: start, end_ms: end, delta: text }) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > 7_200_000) return;
    if (this.phase !== 'active') {
      this.latestUnauthenticatedEnd = Math.max(this.latestUnauthenticatedEnd, end);
      return;
    }
    if (start < this.transcriptFloor || typeof text !== 'string' || text.length > 384) return;
    this.fragments.push({ start, end, text });
    if (this.fragments.length > 256) this.fragments.shift();
  }
  delegate(id, offset) {
    if (this.delegations.has(id)) return;
    this.delegations.add(id);
    // Immediately suppress the provider's pending automatic acknowledgment, before
    // doing any storage or waiting for trailing transcript deltas.
    if (!this.append('thinking', id, '')) { this.end(true); return; }
    if (this.phase !== 'active' || !Number.isSafeInteger(offset) || offset < this.transcriptFloor || offset > 7_200_000) return;
    if (this.pending.size >= 8) return;
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      if (this.phase !== 'active') return; // No acceptance/dispatch if not durably queued yet.
      const request = matchRequest(this.fragments, offset);
      if (!request) {
        this.append('commentary', id, 'No task was queued. For a preset, try saying its full phrase, ending with "end request".');
        return;
      }
      let result;
      try { result = this.bridge.store.queue(this.id, id, request, this.bridge.clock()); }
      catch {
        this.append('commentary', id, 'I could not confirm that task was queued.');
        logFailure('queue commit failed');
        return;
      }
      if (result?.accepted) this.append('commentary', id, `Task queued. Receipt ${result.id.slice(0, 8)}. We can keep talking.`);
      else if (result) this.append('commentary', id, 'That preset was already queued on this call. No duplicate was added.');
    }, 300);
    this.pending.add(timer);
  }
  clear() {
    this.phase = 'closed';
    clearTimeout(this.timer);
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    this.grant = null;
    this.digits = '';
    this.fragments = [];
  }
  async end(hangup) {
    if (this.phase === 'closed') return this.ending;
    this.clear();
    this.socket?.terminate();
    this.ending = (async () => {
      try {
        if (hangup) {
          try { await this.accepting; } catch { /* outcome might still be ambiguous */ }
          await this.bridge.provider.hangup(this.id);
        }
        this.bridge.store.endCall(this.id);
      } catch { logFailure('call cleanup not confirmed; new pairing blocked'); }
      if (this.bridge.call === this) this.bridge.call = null;
    })();
    return this.ending;
  }
}

class WebCall extends Call {
  constructor(bridge, reservation) {
    super(bridge, null, null, webCallMs);
    this.kind = 'webrtc';
    this.reservation = reservation;
    this.touch();
  }
  touch() {
    clearTimeout(this.lease);
    this.lease = setTimeout(() => this.end(true), webLeaseMs);
  }
  async start(sdp) {
    const { provider, store } = this.bridge;
    this.creating = (async () => {
      const result = await provider.createWeb(sdp);
      if (result.rejected) { this.rejected = true; throw Error('provider rejected create'); }
      // Persist the ID before attaching or returning an answer. If the provider
      // cannot supply an ID, the pending reservation stays closed to new starts.
      this.id = result.id;
      if (!store.bindWeb(this.reservation, this.id)) throw Error('cannot bind reservation');
      this.reservation = this.id;
      if (!result.sdp) throw Error('invalid SDP answer');
      return result.sdp;
    })();
    try {
      const answer = await this.creating;
      if (this.phase === 'closed') throw Error('ended during create');
      await this.connect(() => { this.phase = 'active'; });
      if (this.phase !== 'active') throw Error('not active');
      return answer;
    } catch {
      await this.end(true);
      throw Error('cannot start WebRTC');
    }
  }
  terminal(type) {
    if (type === 'session.closed') this.finalized = true;
    if (this.phase !== 'closed') this.end(!this.finalized);
  }
  async end(closeProvider) {
    if (this.phase === 'closed') return this.ending;
    this.clear();
    clearTimeout(this.lease);
    this.ending = (async () => {
      let confirmed = false;
      try {
        try { await this.creating; } catch { /* outcome may still be ambiguous */ }
        if (closeProvider && !this.rejected && !this.finalized) {
          if (!this.id) throw Error('no provider ID recorded');
          try { await this.bridge.provider.closeWeb(this.id, this.socket); }
          catch (error) { if (!this.finalized) throw error; }
        }
        this.bridge.store.endCall(this.reservation);
        confirmed = true;
      } catch { logFailure('WebRTC cleanup not confirmed; new calls blocked'); }
      finally {
        this.socket?.terminate();
        this.bridge.webAuth = null;
        if (this.bridge.call === this) this.bridge.call = null;
      }
      return confirmed;
    })();
    return this.ending;
  }
}
