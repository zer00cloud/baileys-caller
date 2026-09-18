# Experiments

## Experiment 1: Static Source Inspection

QUESTION

Does the local WASM expose a callee answer path?

HYPOTHESIS

The same WhatsApp Web VoIP engine used for outbound calls includes inbound handling.

TEST

Search `assets/wasm/worker-modules.js` and `strings assets/wasm/whatsapp.wasm`.

RESULT

Found `handleIncomingSignalingOffer`, `acceptCall`, `ReceivedCall`, `AcceptSent`, and `wa_call_accept_asymmetric_2`.

EVIDENCE

Local commands:

```bash
rg -n "acceptCall|handleIncomingSignalingOffer" assets/wasm src
strings assets/wasm/whatsapp.wasm | rg "acceptCall|ReceivedCall|AcceptSent"
```

CONCLUSION

SOURCE-CONFIRMED: callee path exists in the bundled WASM.

NEXT STEP

Invoke `acceptCall()` after remote offer is handed to WASM.

## Experiment 2: Build PoC

QUESTION

Can the inbound PoC compile cleanly?

TEST

`npm run build`

RESULT

Passes.

CONCLUSION

BUILD-CONFIRMED: TypeScript changes are internally consistent.

## Experiment 3: Live Account Test

QUESTION

Does Phone A stop ringing, enter connected, and hear MP3?

TEST

Run `npx tsx examples/inbound-auto-play.mts ./auth ./test.mp3`, link Account B, then call Account B from Phone A.

RESULT

NOT RUN in this environment.

NEXT STEP

Run with two authorized WhatsApp accounts/devices.

