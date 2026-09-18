# Blockers

## Live Verification Required

The code compiles, but final success requires a real authorized WhatsApp call test:

1. Phone A calls Account B.
2. Account B runs `examples/inbound-auto-play.mts`.
3. Confirm Phone A transitions from ringing to connected.
4. Confirm MP3 is audible.
5. Confirm remote PCM appears in `audio` events.

## Protocol Risk

UNKNOWN:

- Whether inbound `peerJid` route selection is always correct for LID/PN/device combinations.
- Whether server ack routing for inbound generated `accept` always maps to the concrete caller device.

If Phone A keeps ringing:

- Investigate answer signaling tags emitted by WASM.
- Verify route `to` JID and `call-creator`.

If Phone A connects but hears silence:

- Investigate capture start callback, feeder chunks, and PCM sample format.

