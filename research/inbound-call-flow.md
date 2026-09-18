# Inbound Call Flow

## Upstream Baileys

SOURCE-CONFIRMED:

- Baileys handles incoming `<call>` nodes in `handleCall()`.
- It extracts the first child node, maps child tag to status using `getCallStatusFromNode()`, and emits `sock.ev.emit("call", [call])`.
- For `offer`, it stores metadata in `callOfferCache` for later `accept`/`reject`/`terminate` events.
- Baileys does not expose a media-capable answer path; it exposes `rejectCall()`.

## baileys-caller Existing Before Patch

SOURCE-CONFIRMED:

- `VoipClient.connect()` listens on raw websocket `CB:call`.
- `SignalingBridge.processIncomingCall()` handles encrypted offer decryption, base64-encodes the usable binary node, and for tag `offer` calls `voip.handleSignalingOffer()`.
- `WasmEngine.handleSignalingOffer()` calls WASM `handleIncomingSignalingOffer(...)`.

PARTIALLY SUPPORTED:

- The remote offer could already reach the WASM.
- Missing piece was a public inbound call object and a wrapper for WASM `acceptCall()`.

## Inbound PoC After Patch

HYPOTHESIS / NEEDS LIVE TEST:

1. Phone A calls Account B.
2. Baileys raw websocket emits `CB:call` with child `offer`.
3. `extractIncomingOffer()` creates an inbound `ActiveCall`.
4. `SignalingBridge.processIncomingCall()` forwards offer to WASM.
5. Example receives `incoming-call`.
6. `call.answer()` invokes WASM `acceptCall(true, false)`.
7. WASM emits accept/preaccept/transport signaling through existing `onSignalingXmpp` path.
8. State transitions to `Active`.
9. Example calls `call.play("./test.mp3")`.
10. Audio feeder decodes MP3 to Float32 PCM at WASM-requested sample rate/chunk size.

