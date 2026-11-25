import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { cleanResult, idPattern, matchRequest, receiptPattern } from './policy.mjs';

const armMs = 120_000;
const pairMs = 45_000;
const callMs = 20 * 60_000;
const hash = (key, digits) => createHmac('sha256', key).update(digits).digest();
const validId = (id) => typeof id === 'string' && idPattern.test(id);
const logFailure = (kind) => process.stderr.write(`voice-bridge: ${kind}\n`);

export class Bridge {
  constructor({ store, provider, linkOrigin = null, clock = Date.now, code = () => String(randomInt(1e8)).padStart(8, '0') }) {
    Object.assign(this, { store, provider, linkOrigin, clock, code });
  }
  arm() {
    if (this.call || this.stopped || this.recovering || this.store.unclosed(this.clock()).length) return null;
    const digits = this.code();
    const key = randomBytes(32);
    const issued = this.clock();
    clearTimeout(this.armTimer);
    this.grant = { issued, code: hash(key, digits), key };
    this.armTimer = setTimeout(() => { this.grant = null; }, armMs);
    this.armTimer.unref();
    return { digits, expires_at: issued + armMs };
  }
  async recoverCalls() {
    this.recovering = true;
    try {
      for (const id of this.store.unclosed(this.clock())) {
        if (this.stopped) break;
        if (!validId(id)) continue;
        try {
          await this.provider.hangup(id);
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
    this.grant = null;
    clearTimeout(this.armTimer);
    await this.call?.end(true);
  }
}

class Call {
  constructor(bridge, id, grant) {
    Object.assign(this, { bridge, id, grant });
    this.phase = 'connecting';
    this.digits = '';
    this.seen = new Set();
    this.fragments = [];
    this.delegations = new Set();
    this.pending = new Set();
    this.transcriptFloor = 0;
    this.latestUnauthenticatedEnd = 0;
    this.timer = setTimeout(() => this.end(true), pairMs);
  }
  async start() {
    const { provider } = this.bridge;
    this.accepting = provider.accept(this.id);
    try {
      await this.accepting;
      if (this.phase === 'closed') return;
      this.socket = provider.attach(this.id);
      this.socket.on('open', () => {
        if (this.phase === 'closed') return;
        this.phase = 'muting';
        this.mute = this.send('session.input_audio.mute');
      });
      this.socket.on('message', (bytes, isBinary) => this.receive(bytes, isBinary));
      this.socket.on('error', () => this.end(true));
      this.socket.on('close', () => this.end(true));
    } catch {
      if (this.phase !== 'closed') logFailure('call setup failed');
      this.end(true);
    }
  }
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
    if (this.phase === 'closed' || isBinary) return;
    let event;
    try { event = JSON.parse(bytes); } catch { return; }
    if (!event || typeof event !== 'object') return;
    const { type, event_id } = event;
    if (!['session.closed', 'transport.failed', 'session.input_audio.muted', 'session.input_audio.unmuted',
      'transport.dtmf.received', 'session.input_transcript.delta', 'session.delegation.created'].includes(type)) return;
    if (!validId(event_id) || this.seen.has(event_id)) return;
    if (this.seen.size >= 32_768) { this.end(true); return; }
    this.seen.add(event_id);
    if (type === 'session.closed' || type === 'transport.failed') { this.end(false); return; }
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
    this.append('thinking', id, '');
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
  async end(hangup) {
    if (this.phase === 'closed') return this.ending;
    this.phase = 'closed';
    clearTimeout(this.timer);
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    this.grant = null;
    this.digits = '';
    this.fragments = [];
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
