# Local test scope

Install the locked dependency once with `npm ci --ignore-scripts --no-audit --no-fund`. From that point, the suite runs without API keys, Telegram, SIP accounts, a real Pots process, or external network access:

| Command | What it exercises |
| --- | --- |
| `npm test` | Raw signed OpenAI webhook validation, disarmed/unauthorized calls, expiry and duplicate deliveries, correct and incorrect keypad pairing; mocked Live accept/attach and WebSocket events; queue/claim/dedup/hangup and restart; actual local CLI claim and result registration; fake Pots CLI receipts and private target/ID validation; real SQLite WAL surviving abrupt writer termination; orphan reservation cleanup. |
| `npm run demo` | Focused simulated flow with two client delegations while the first child is outstanding, continued socket activity, provider replay, hangup, bridge restart, queue replay and a downstream fake Telegram delivery acknowledgment. |

The fixture has no audio engine or SIP stack. It verifies that control messages and storage semantics continue while work is pending, not that a call sounds natural, that a phone takes DTMF, or that a human hears an acknowledgment. The mock executes a real **local fake** Pots executable, not the actual Pots / Telegram integrations. A local CLI completes jobs to model the end of a one-off child; the installed Pots main agent and child are not driven. Real handset, provider model/delegation, recipient delivery, and agent behavior are separate acceptance criteria in the [manual, potentially billable smoke](sip-smoke.md).
