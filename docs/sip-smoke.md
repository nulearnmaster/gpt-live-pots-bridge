# Manual GPT-Live SIP smoke — requires separate approval and may incur charges

**Not an automated test.** The fixture cannot prove OpenAI project access, trunk interoperability, actual DTMF delivery, language recognition, spoken acknowledgment timing, child execution, Bluetooth audio, or Telegram delivery. Don't run this checklist until the operator approves costs and controls the accounts, endpoint, route and verified DM. Never do initial setup while driving.

## Preflight

- Confirm that the project has access to `gpt-live-1` and that GPT-Live SIP is enabled. Use a project-scoped API credential and configure `live.transport.incoming` for the same project. Route the provider's trusted trunk with TLS signaling and SRTP media to the appropriate `sip:$PROJECT_ID@sip.api.openai.com;transport=tls` or regional destination. Use provider documentation for routing, certificates, media and DTMF reliability. Require a restricted trunk, spending alarms and a duration cap; don't leave an unrestricted dial-in armed.
- Configure the HTTPS ingress as described in the README and pass signed raw body/headers unchanged. `serve` binds to loopback only. `worker` and pairing use separate Unix sockets; use a dedicated service UID in an exposed pilot. Plan to watch only status and counters, not media, headers, credentials, or session payloads. Set approved budgets for carrier/number, Live usage, and the selected Pots agent models. Decide a manual stop time for the smoke.
- Verify the intended recipient independently in the exact Telegram private conversation connected to that bot. Confirm the owner-controlled Pots dispatch instructions and permission posture; do not use a private productive task. Failed and rejected cases need no new delivery target.

## Positive path

1. Start the service and worker, arm from a private terminal, dial from a parked handset, and confirm the call carries Live audio over that handset/Bluetooth. Confirm the project usage report shows the Live API/model, not a Realtime session. Check the generic AI disclosure. On the keypad enter the code plus `#`; verify that speech before pairing did not produce any job.
2. Speak “Queue meeting checklist, end request.” Confirm `list` shows the receipt before or when the spoken queued confirmation occurs; it is not a child-start or child-done promise. Concurrently ask a harmless follow-up question and try “Queue weekly review checklist, end request.” The call should remain conversational with the first draft outstanding. Repeat the first preset and verify no new receipt. Test the Korean versions separately on the target handset.
3. Interrupt playback with a normal question and then hang up before completion. Verify the same main Pots bot claimed the jobs, used a one-off child per claimed ID, and kept working. Reopen the private Telegram DM: results should match UUIDs and presets, include the short matched phrase, and carry only a validated optional link. If a result finishes while the call is open, verify only status (not draft or URL) is voiced. Check separately the queued job, child completion, delivered message, and audible speech; these are independent outcomes.

## Negative and recovery path

1. In a separately budgeted test, call with no grant (must not accept) and use a wrong code on an armed call (must not unmute/queue; should terminate). Try a general imperative such as “send an email”; no task should be queued. Confirm spoofable SIP identity metadata is not used for access. Confirm the webhook does not expose internal routes or accept unsigned/mutated requests with a synthetic request, not another real phone call.
2. During a controlled outage, stop/restart the worker after a receipt. The service should retain it and retry with the same wake/send IDs. Test service restart **after** hanging up. Verify any stuck claim is reconciled by an operator rather than automated double-launch. Compare the private DM, Pots receipts and queue state; do not resend with a new ID to force a result into Telegram.
3. Stop the worker and service, disarm, check usage, and remove/disable the external inbound route when the pilot is over. If termination could not be confirmed, end the call using your provider's controls.

## References

Public docs checked November 2026:

- [Introducing GPT-Live](https://openai.com/index/introducing-gpt-live/)
- [OpenAI Live telephony and SIP](https://developers.openai.com/api/docs/guides/voice-sip?api=live) and [accept endpoint](https://developers.openai.com/api/reference/resources/live/subresources/sessions/methods/accept)
- [Server-side controls, sideband and replay](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live) and [Live sideband event contracts](https://developers.openai.com/api/reference/resources/live/sideband-websocket)
- [Live client delegation, acknowledgments, and output appends](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client), and [Live transcript deltas](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)
- [Webhooks](https://developers.openai.com/api/docs/guides/webhooks) and [Standard Webhooks signing spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md#verifying-webhook-authenticity)
- [GPT-Live partner integrations](https://developers.openai.com/api/docs/guides/live-partner-integrations) and [Voice latency and cost](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live)
