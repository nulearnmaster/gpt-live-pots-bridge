import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { cleanResult, isPreset, matchesExcerpt, ownerPreset, receiptPattern, validBotName, validResultAddress } from './policy.mjs';

function run(binary, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const pieces = [];
    let size = 0;
    child.stdout.on('data', (bytes) => {
      size += bytes.length;
      if (size > 32 * 1024) child.kill('SIGKILL');
      else pieces.push(bytes);
    });
    child.stdin.on('error', () => {}); // Exit status/JSON receipt are still checked.
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 32 * 1024) reject(Error('Pots command failed'));
      else resolve(Buffer.concat(pieces));
    });
    child.stdin.end(input);
  });
}
const failure = () => process.stderr.write('voice-bridge worker: item not confirmed; keeping its stable retry ID\n');

export function potsSink({ binary, bot, address }) {
  if (typeof binary !== 'string' || !isAbsolute(binary) || !validBotName(bot) || !validResultAddress(address)) {
    throw Error('configure an absolute Pots binary, bot, and verified canonical Telegram DM place');
  }
  return async (kind, id, text) => {
    if (!receiptPattern.test(id)) throw Error('invalid receipt');
    let args;
    if (kind === 'wake') args = ['wake', '--bot', bot, '--id', `voice-wake-${id}`, '--from', 'voice-bridge', '--note', text];
    else if (kind === 'send') args = ['send', '--bot', bot, '--id', `voice-result-${id}`, address, '-'];
    else throw Error('invalid operation');
    const env = { ...process.env };
    for (const key of ['OPENAI_API_KEY', 'OPENAI_WEBHOOK_SECRET', 'VOICE_WEB_PROXY_KEY', 'POTS_CHILD', 'POTS_FROM']) delete env[key];
    const stdout = await run(binary, args, env, kind === 'send' ? text : undefined);
    const result = JSON.parse(stdout);
    if (kind === 'wake' && (!Number.isSafeInteger(result?.id) || result.note !== text)) throw Error('wake not confirmed');
    if (kind === 'send' && (typeof result?.message !== 'string' || !result.message ||
        (result.place !== undefined && result.place !== address) || !result.message.startsWith(`${address}/`) ||
        !/^[1-9][0-9]*$/.test(result.message.slice(address.length + 1)))) throw Error('send not confirmed');
    return result;
  };
}

export async function workOnce(local, sink, linkOrigin = null, notifyFailure = failure, contextRoute = null) {
  const { wakes, deliveries } = await local('/pending');
  let confirmed = 0;
  for (const item of wakes) {
    try {
      const context = item.preset === ownerPreset && contextRoute && item.route === contextRoute;
      if (!receiptPattern.test(item.id) || (!context && !isPreset(item.preset))) throw Error('invalid wake payload');
      await sink('wake', item.id, context
        ? `Voice bridge has an owner-context receipt ${item.id}. Use only the locally installed voice-bridge main-agent claim/dispatch procedure.`
        : `Voice bridge has a scoped draft receipt ${item.id}. Use only the locally installed voice-bridge claim/dispatch procedure.`);
      await local('/mark-wake', { id: item.id });
      confirmed++;
    } catch { notifyFailure(); }
  }
  for (const item of deliveries) {
    try {
      const context = item.preset === ownerPreset && contextRoute && item.route === contextRoute;
      if (!receiptPattern.test(item.id) || (!context && !matchesExcerpt(item.preset, item.excerpt)) || !['done', 'failed'].includes(item.state)) throw Error('invalid result payload');
      const result = cleanResult(item, linkOrigin);
      if (!result) throw Error('invalid result');
      const heading = context ? `Pots voice request: ${item.state}\nReceipt: ${item.id}`
        : `Voice draft: ${item.state}\nReceipt: ${item.id}\nPreset: ${item.preset}\nHeard: ${item.excerpt}`;
      const message = `${heading}\n\n${result.summary}${result.link ? `\n\n${result.link}` : ''}`;
      await sink('send', item.id, message);
      await local('/mark-delivery', { id: item.id });
      confirmed++;
    } catch { notifyFailure(); }
  }
  return confirmed;
}
