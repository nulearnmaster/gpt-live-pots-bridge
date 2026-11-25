#!/usr/bin/env node
// Fake public Pots CLI semantics for offline tests. No gateway or provider calls.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.env.FAKE_POTS_LEDGER;
assert(path);
let ledger = {};
try { ledger = JSON.parse(readFileSync(path)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const [kind, botOpt, bot, idOpt, id, ...rest] = process.argv.slice(2);
assert.deepEqual([botOpt, bot, idOpt], ['--bot', process.env.FAKE_POTS_EXPECT_BOT ?? 'demo-bot', '--id']);
assert(['wake', 'send'].includes(kind));
assert(id.startsWith(kind === 'wake' ? 'voice-wake-' : 'voice-result-'));
assert(!process.env.OPENAI_API_KEY && !process.env.OPENAI_WEBHOOK_SECRET);
const existing = ledger[id];
if (existing) {
  existing.calls++;
} else if (kind === 'wake') {
  assert.deepEqual(rest.slice(0, 3), ['--from', 'voice-bridge', '--note']);
  const note = rest[3];
  assert(note.includes(id.slice('voice-wake-'.length)));
  ledger[id] = { bot, calls: 1, result: { id: Object.keys(ledger).length + 1, note, due_at: 1800000010000,
    source: 'voice-bridge', request_id: id, set_by: 'agent' } };
} else {
  assert.deepEqual(rest, ['telegram:#123456', '-']);
  const text = readFileSync(0, 'utf8');
  assert(text.includes(id.slice('voice-result-'.length)));
  ledger[id] = { bot, calls: 1, text, result: { place: rest[0], message: `${rest[0]}/42` } };
}
writeFileSync(path, JSON.stringify(ledger), { mode: 0o600 });
console.log(JSON.stringify({ ...ledger[id].result, ...(kind === 'send' && existing ? { repeated: true } : {}) }));
