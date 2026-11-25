# GPT-Live → Pots voice bridge

Talk to **GPT-Live** and let your **existing Pots bot** handle background drafts. There are two supported source paths in this prototype:

| Transport | On your phone | Current verification |
| --- | --- | --- |
| **Mobile web (no number)** | Open a private invitation in Safari or Chrome while parked, approve the displayed cost and microphone, then talk hands-free. Browser and GPT-Live stream both directions over WebRTC. | Local protocol fixtures and native Chromium synthetic-mic test; live provider, iOS/Android, Bluetooth, and barge-in need a [parked paid smoke test](docs/web-smoke.md). |
| **Inbound SIP** | Dial the configured SIP number and enter the one-time keypad PIN. | Local signed webhook and SIP control fixtures; real trunk, carrier and handset require the separate [paid SIP smoke](docs/sip-smoke.md). |

Both use the **GPT-Live API with client delegation**, not OpenAI Realtime, clip uploads, speech-to-text turns, or push-to-talk. Hang up or close the page and accepted work still runs; detailed results go only to the same operator-configured private Telegram inbox. This is a single-owner prototype, not a public service. The only presets draft meeting or weekly-review checklists and follow-up **templates**. They do not send mail, run commands, approve actions, or access private records.

```text
Phone browser ⇄ native WebRTC audio ⇄ OpenAI GPT-Live
        └── private HTTPS SDP ─┐       │
Handset ⇄ SIP trunk (TLS/SRTP) ⇄ OpenAI GPT-Live
                               │       │ sideband (SIP adds a signed webhook)
                               ▼       ▼
                       One bridge / durable SQLite queue
                                     │ permissioned Unix socket
                                     ▼
                     Pots worker → existing main agent → one-off child
                   child completes over local IPC → verified private inbox
```

## Zero-credential demo

Requires Linux/Unix with Unix-domain sockets, Node.js 24+, and npm. The demo and tests never call OpenAI, a SIP trunk, Telegram, or a real Pots installation. A local HTTP/WebSocket fixture talks the documented provider protocol; a local executable emulates Pots and records deduplicated operations. There is no synthesized audio or actual phone call.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test       # complete offline suite (after dependency installation)
npm run demo   # focused end-to-end simulations for both transports
```

The demo checks that a response is not emitted before the SQLite commit, that a second voice request is accepted while a simulated child is outstanding, and that a hangup and restarts do not drop tasks or duplicate private delivery in the fixture.

## How callers use it

1. **While parked**, choose one path:
   - **Web:** open a fresh personal invitation at the configured private HTTPS origin. Tap **비용에 동의하고 시작** (agree to the cost and start), allow microphone access, and wait for **연결됐어요** (connected). The page discloses the **~US$0.10** Live estimate and two-minute close attempt. Delayed confirmation can add charges and Pots costs are separate. `소리 켜기` (enable sound) appears only if autoplay is blocked. No dialing, push-to-talk, or tap after each request.
   - **SIP:** the operator arms one attempt and gets a single-use eight-digit code. Dial within two minutes; wait for the prompt, enter the code with the keypad followed by `#`, and wait for pairing confirmation. Never read the code aloud.
2. Speak a full request, including its ending marker:

   | English | 한국어 |
   | --- | --- |
   | “Queue meeting checklist, end request.” | “회의 체크리스트 접수, 요청 끝.” |
   | “Queue weekly review checklist, end request.” | “주간 리뷰 체크리스트 접수, 요청 끝.” |
   | “Queue follow-up email template, end request.” | “후속 이메일 양식 접수, 요청 끝.” |

   The matching is deliberately strict: speak the phrase as one utterance. Conversation can continue normally between requests. When the assembled text does not exactly match, the bridge does not queue the task. GPT-Live does not send a transcript-done event in this API; even a complete-looking phrase may be a quote, a late or truncated fragment, or an ASR mishearing. Keep presets harmless even if triggered unintentionally. Each preset can be queued once per call.
3. “Task queued” and its short receipt mean the bridge committed a job, **not** that a child started. A result that finishes during the call yields a short status update; detailed results go only to the configured inbox, whether or not the caller is still on the line. The inbox message includes the full receipt, matched excerpt, result, and optional artifact link.

## Opt-in real web setup (number-free)

Use the same local state, admin socket, worker socket, bot, and private inbox setup described below (steps 1, 2, and 4). The web transport does **not** need an SIP trunk, webhook, number, or webhook secret. Configure a dedicated private HTTPS origin for the owner's phone, never a public tunnel or the Pots Gateway. See the [private HTTPS and mobile runbook](docs/web-smoke.md) before enabling:

```sh
# Billable capability. Don't run this for the offline demo.
node src/cli.mjs serve --enable-paid-webrtc
node src/cli.mjs invite-web   # private service-owner TTY; returns one-time URL
```

To enable both, run **one** `serve --enable-paid-sip --enable-paid-webrtc` process with two distinct loopback ports. The transports share one call slot and one SQLite queue; issue only one SIP arm or web invitation at a time. The worker is separate and needs its own explicit `--enable-pots-effects` switch regardless of transport.

## Opt-in real SIP and shared Pots setup

**Do not enable this just to run the demo.** Accepting SIP calls, GPT-Live usage, trunk/number usage, and Pots model use can incur charges. Budget and approve these separately. No accounts, trunk, endpoint, or secrets are created by this repository. See [the manual smoke plan](docs/sip-smoke.md) before a first call.

1. Install the dependencies on a machine with Pots and a verified private chat. Choose an existing bot. Use the canonical Telegram private **place address** `telegram:#<positive numeric chat ID>` (not a person `@` address, group, message, username, or thread). Verify the exact place using an owner-controlled authenticated channel or an out-of-band challenge; don't infer it from a username, number display, group membership, or a voice request. If your Pots installation provides owner-only Telegram DMs, use that control too. The bridge does not provision, verify, or update a Telegram account and does not need a Telegram token.
2. Give the bridge a dedicated private state directory (`0700`) and admin socket path inside it. Configure a separate worker socket path. For an isolated deployment, use the permission topology in [Security and operations](docs/security.md). For a local single-UID pilot:

   ```sh
   install -d -m 700 "$HOME/.local/state/voice-bridge"
   export VOICE_STATE_DB="$HOME/.local/state/voice-bridge/queue.sqlite"
   export VOICE_ADMIN_SOCKET="$HOME/.local/state/voice-bridge/admin.sock"
   export VOICE_WORKER_SOCKET="$HOME/.local/state/voice-bridge/worker.sock"
   ```

   [`.env.example`](.env.example) documents the other variables; the program doesn't load an env file. Inject `OPENAI_API_KEY` and (when SIP is enabled) `OPENAI_WEBHOOK_SECRET` privately into the **service** only. Only the **worker** gets `VOICE_POTS_BIN` (an absolute executable path), `VOICE_POTS_BOT`, and `VOICE_RESULT_ADDRESS` (the verified, fixed place). Both get `VOICE_LINK_ORIGIN` only if you use result links: a single, exact HTTPS origin, without a path. Omit it to disable links.
3. Configure a trunk that supports TLS signaling and SRTP and route it to the project’s Live SIP URI according to [OpenAI's SIP guide](https://developers.openai.com/api/docs/guides/voice-sip?api=live). The project must support **GPT-Live SIP**. Use the same project for the API key and the `live.transport.incoming` webhook subscription. Use a managed HTTPS reverse proxy for **only** `POST /webhooks/openai` to `127.0.0.1:8788` (or `VOICE_WEBHOOK_PORT`). Preserve the raw body and webhook signing headers; never expose the worker/admin sockets, Pots Gateway, or the machine itself. Require provider/trunk-side ingress restrictions as discussed in the security guide. This bridge deliberately ignores legacy and Realtime webhooks.
4. Add [the example dispatch instructions](examples/pots-dispatch.md) to the **selected bot's own instructions**, filling the trusted local command/socket paths. Pots v0.8.9 exposes durable `wake --id` and `send --id` in its CLI. There is no public one-shot child start command in that CLI: **the existing main agent** claims a queued receipt and uses its normal one-off child feature. No gateway API, private database, new bot, or scheduled child workaround is needed. The lab fixture emulates the CLI and manual child completion, not an installed agent's obedience to those instructions.
5. With explicit operator approval, run one instance of each in separate terminals or supervised services. These switches enable real effects; they are not test commands.

   ```sh
   node src/cli.mjs serve --enable-paid-sip
   node src/cli.mjs worker --enable-pots-effects
   ```

   Run `node src/cli.mjs arm` from a private TTY as the service owner. `node src/cli.mjs list` on the worker socket shows recent receipts without result content. No public endpoint can submit a command, select the destination, return stored results, or arm the bridge.

## Design and limits

- Web uses a one-use, short-lived owner invitation, HTTPS, a bounded same-origin SDP exchange with a fixed Live configuration, and an authenticated sideband. The browser gets an SDP answer, never a provider API key or client secret. It sends no commands on the Live data channel; only the server sideband can send Live commands. End/exit stops the local mic; a missing page heartbeat or pilot timer closes the remote session. If a create or close outcome is ambiguous, the service blocks new sessions rather than retrying a billable create. Follow the [web runbook](docs/web-smoke.md) for reconciliation.

- The Live webhook is authenticated over raw bytes (Standard Webhooks HMAC, bounded clock skew) and deduplicated by delivery and Live session IDs. **`From`, `To`, and other SIP headers do not authorize a caller.** The owner-issued, time-limited DTMF challenge proves possession of a one-time code, not the identity of a human. One call can reserve an armed slot. Calls outside that slot are not accepted (the provider may ring until its pending-call timeout).
- The sideband consumes input transcript deltas and `session.delegation.created`, which contains timestamp/ID metadata, not a command. Fixed grammar, a recent complete phrase, a valid session, and a durable insert are required. The bridge suppresses Live's pending automatic delegation acknowledgment and emits its own correlated status **only after the SQLite commit**. OpenAI's native model may still speak independently; only a media relay that controls playback can guarantee silencing or exact words. Sideband receipt does not prove audibility.
- Voice streaming does not await an LLM child. `session.closed`, socket failure, or voice interruption cannot erase an accepted job. No cross-call audio/session recovery is promised. On restart, the bridge attempts cleanup of unclosed provider sessions (SIP REST hangup or WebRTC sideband close). Ambiguous web cleanup blocks both transports until confirmed; legacy SIP reservations age out as documented. Re-arm for a new call; outstanding work remains in the queue.
- SQLite persists receipts, wake state, claims, and result delivery. Pots operations retry with stable IDs. A claim is single-consumer: crashes **after** a claim but before a child is started are intentionally not replayed automatically; reconcile from the selected bot, then complete or mark failed. Message-platform delivery under ambiguous external failure is not advertised as exactly once.
- No raw audio, arbitrary conversation transcript, SIP headers, DTMF digits, or API credentials are persisted by the bridge. The allowlisted excerpt, task status, and text result are retained locally and sent to the fixed inbox where applicable. The Live session explicitly sets `store: false` (no opt-in session storage for forking/recording download). Third-party abuse monitoring or other retention is independent. There is no general shell, deployment, notification targeting, or approval tool over the voice call.

See [security and operations](docs/security.md), [test scope](docs/testing.md), and the official protocol references for [web](docs/web-smoke.md#references) and [SIP](docs/sip-smoke.md#references). Contributions welcome via [CONTRIBUTING.md](CONTRIBUTING.md).
