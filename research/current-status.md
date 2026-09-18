# Current Status

Date: 2026-09-18

## Environment

- OS: Linux shabrr-PC 7.0.0-31-generic x86_64 Ubuntu 24.04 family
- Node.js: v22.22.3
- Local repo: `baileys-caller`
- baileys-caller commit SHA: `36c6e0a03d7d80723b4f203a45d4cb9e1a4b86f6`
- baileys-caller version: `0.1.0`
- Baileys latest observed HEAD: `0af2386292907f7d9742d8d41f830d8c48208fa1`
- Baileys latest npm/master version: `7.0.0-rc14`
- Local peer dependency before this patch: `@whiskeysockets/baileys@^7.0.0-rc11`

## Capability Matrix

| Question | Status | Evidence |
| --- | --- | --- |
| Can Baileys detect incoming calls? | CONFIRMED | Baileys `handleCall()` emits `ev.emit('call', [call])`; source: `messages-recv.ts` lines 1671-1724, https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Socket/messages-recv.ts |
| Can Baileys obtain incoming offer metadata? | CONFIRMED | Baileys extracts `call-id`, `from`/`call-creator`, `caller_pn`, `video`, group attrs into `WACallEvent`; same source lines 1680-1705. |
| Can Baileys reject an incoming call? | CONFIRMED | `rejectCall(callId, callFrom)` sends `<call><reject call-id=... call-creator=... count="0"/></call>`; source lines 518-538. |
| Can Baileys answer an incoming call? | NOT SUPPORTED | Latest Baileys exposes `rejectCall`, but no source-confirmed `answerCall` equivalent in upstream `messages-recv.ts`; answering requires WhatsApp Web VoIP WASM `acceptCall()`. |
| Can baileys-caller initiate outbound calls? | CONFIRMED | `VoipClient.call()` calls `WasmEngine.startCall()` in `src/index.mts`. |
| Can baileys-caller send audio? | CONFIRMED | `AudioFeeder` decodes source through ffmpeg to `f32le` and calls `engine.sendAudioData()`; `src/audio-feeder.mts`, `src/index.mts`. |
| Can baileys-caller receive audio? | CONFIRMED | WASM playback loop calls `requestAudioDataFromWasmVoip()` and emits `audio`; `src/wasm-engine.mts`. |
| Can baileys-caller handle incoming calls before this patch? | PARTIALLY SUPPORTED | It already routed `CB:call` into `processIncomingCall()` and called `handleIncomingSignalingOffer()`, but had no public inbound call object and did not expose `acceptCall()`. |
| Can this patch answer inbound calls? | HYPOTHESIS / NEEDS LIVE TEST | Patch exposes WASM `acceptCall()` and creates `incoming-call`; build passes, but Phone A -> Account B test has not been run in this environment. |

## Implemented PoC Surface

```ts
client.on("incoming-call", async call => {
  await call.answer();
  await call.waitForConnected();
  await call.play("./test.mp3");
});
```

Runnable example:

```bash
npx tsx examples/inbound-auto-play.mts ./auth ./test.mp3
```

## Verification Performed

- SOURCE-CONFIRMED: local WASM bundle contains `handleIncomingSignalingOffer`, `acceptCall`, `rejectCall`, `ReceivedCall`, `AcceptSent`, `Active`, and `wa_call_accept_asymmetric_2`.
- SOURCE-CONFIRMED: `assets/wasm/worker-modules.js` maps RPC method `acceptCall` to `t.acceptCall(isMicEnabled, isCameraEnabled)`.
- BUILD: `npm run build` passes.
- AUDIO DEPENDENCY: added `ffmpeg-static`; `node_modules/ffmpeg-static/ffmpeg -version` runs and reports FFmpeg 7.0.2-static.

## Not Yet Verified

- OBSERVED live Phone A ringing -> connected transition.
- OBSERVED caller hearing MP3.
- OBSERVED caller microphone PCM saved to WAV.

