#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { Bridge } from './bridge.mjs';
import { Store } from './store.mjs';
import { openAI, signingKey } from './openai.mjs';
import { listen, listenLocal, localRequest, localServer, publicServer, requirePrivateDirectory, stopServer } from './server.mjs';
import { tasks, isPreset, receiptPattern } from './policy.mjs';
import { potsSink, workOnce } from './worker.mjs';

const env = process.env;
const print = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);
const complain = (text) => process.stderr.write(`voice-bridge: ${text}\n`);
const local = (path, data) => localRequest(env.VOICE_WORKER_SOCKET, path, data);

function origin() {
  if (!env.VOICE_LINK_ORIGIN) return null;
  const url = new URL(env.VOICE_LINK_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== env.VOICE_LINK_ORIGIN) throw Error('use a bare HTTPS origin');
  return url.origin;
}
async function serve() {
  const port = Number(env.VOICE_WEBHOOK_PORT ?? '8788');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('invalid port');
  if (!env.OPENAI_API_KEY || !/^[\x21-\x7e]+$/.test(env.OPENAI_API_KEY)) throw Error('missing project credential');
  const key = signingKey(env.OPENAI_WEBHOOK_SECRET);
  const linkOrigin = origin();
  requirePrivateDirectory(env.VOICE_STATE_DB, true);
  requirePrivateDirectory(env.VOICE_ADMIN_SOCKET, true);
  requirePrivateDirectory(env.VOICE_WORKER_SOCKET);
  const store = new Store(env.VOICE_STATE_DB);
  const bridge = new Bridge({ store, provider: openAI(env.OPENAI_API_KEY), linkOrigin });
  const servers = [];
  let stopping;
  let maintenance;
  let recovery;
  const stop = () => stopping ??= (async () => {
    clearInterval(maintenance);
    await Promise.all([...servers.map(stopServer), bridge.stop(), recovery]);
    store.close();
  })();
  try {
    servers.push(await listen(publicServer(bridge, key), { host: '127.0.0.1', port }));
    servers.push(await listenLocal(localServer(bridge), env.VOICE_WORKER_SOCKET, env.VOICE_SHARED_GROUP === 'yes' ? 0o660 : 0o600));
    servers.push(await listenLocal(localServer(bridge, true), env.VOICE_ADMIN_SOCKET, 0o600));
    const purge = () => { try { store.purge(Date.now()); } catch { complain('state cleanup failed'); } };
    purge();
    maintenance = setInterval(purge, 3600_000);
    recovery = bridge.recoverCalls().catch(() => complain('previous call cleanup failed'));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    complain('listening; inbound calls are disarmed');
  } catch (error) { await stop(); throw error; }
}
async function worker() {
  const linkOrigin = origin();
  const sink = potsSink({ binary: env.VOICE_POTS_BIN, bot: env.VOICE_POTS_BOT, address: env.VOICE_RESULT_ADDRESS });
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  let delay = 1000;
  while (!stop.signal.aborted) {
    let failed = false;
    let itemFailed = false;
    try {
      await workOnce(local, sink, linkOrigin, () => { itemFailed = failed = true; });
    } catch { failed = true; }
    if (failed) complain(itemFailed ? 'Pots operation not confirmed; retrying with its original ID' : 'worker socket unavailable');
    delay = failed ? Math.min(delay * 2, 30_000) : 1000;
    await sleep(delay, null, { signal: stop.signal }).catch(() => {});
  }
}
async function readResult() {
  const pieces = [];
  let size = 0;
  for await (const bytes of process.stdin) {
    size += bytes.length;
    if (size > 8192) throw Error('oversized result');
    pieces.push(bytes);
  }
  const result = JSON.parse(Buffer.concat(pieces));
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some((key) => !['summary', 'link'].includes(key))) {
    throw Error('expected summary and optional link');
  }
  return result;
}

async function main(args) {
  process.umask(0o077);
  const [command, arg] = args;
  if (command === 'serve' && arg === '--enable-paid-sip' && args.length === 2) return serve();
  if (command === 'worker' && arg === '--enable-pots-effects' && args.length === 2) return worker();
  if (command === 'arm' && args.length === 1 && process.stdout.isTTY) return print(await localRequest(env.VOICE_ADMIN_SOCKET, '/arm'));
  if (command === 'list' && args.length === 1) return print(await local('/list'));
  if (args.length === 2 && receiptPattern.test(arg)) {
    if (command === 'claim') {
      const claim = await local('/claim', { id: arg });
      if (claim.id !== arg || !isPreset(claim.preset)) throw Error('invalid claim');
      return print({ ...claim, brief: tasks[claim.preset] });
    }
    if (command === 'complete') return print(await local('/complete', { ...await readResult(), id: arg }));
    if (command === 'fail') return print(await local('/fail', { id: arg }));
  }
  complain('usage: serve --enable-paid-sip | worker --enable-pots-effects | arm (TTY only) | list | claim ID | complete ID (JSON stdin) | fail ID');
  process.exitCode = 2;
}
main(process.argv.slice(2)).catch(() => { complain('command failed; check local setup, permissions, input and receipt state'); process.exitCode = 1; });
