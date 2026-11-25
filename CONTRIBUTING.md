# Contributing

- Run `npm ci --ignore-scripts --no-audit --no-fund` and `npm test`. Include a local failure/regression test for protocol, authorization or retry changes. Don't submit captured media, real provider events/IDs, chat addresses, tokens, private transcripts, logs or local state. Use synthetic fixtures.
- Start with the documented protocol and the observed public CLI contract. Keep authentication and status reporting distinct from speech and don't convert a prompt into authorization. Propose new presets as narrow, reviewable policies (no generic executor, public admin API, unrestricted URLs or dynamic result destination).
- This project is independent of OpenAI and Pots. It uses their documented surfaces without redistributing their code. Third-party runtime dependency [`ws`](https://www.npmjs.com/package/ws) has its own MIT license and is not vendored.
- Related community projects: [pi-voice](https://github.com/lprsrts/pi-voice) for Live delegation and Pi CLI, and [hui](https://github.com/DaniFdz/hui) for Pi Durable browser voice. This project targets WebRTC and inbound SIP with an existing Pots bot; it doesn't embed or copy code from either.
- The contributed source is offered under the [MIT license](LICENSE). Raise a security concern without posting reproduction material containing a private call, credential or recipient.
