# WASM Map

SOURCE-CONFIRMED local evidence:

- `assets/wasm/worker-modules.js` contains the RPC dispatch table for:
  - `voipInit`
  - `startCall`
  - `acceptCall`
  - `rejectCall`
  - `endCall`
  - `handleIncomingSignalingOffer`
  - `handleIncomingSignalingMessage`
  - `handleIncomingSignalingAck`
  - `handleIncomingSignalingReceipt`
  - `handleOnTransportMessage`
  - `setCallMute`
- `strings assets/wasm/whatsapp.wasm` finds:
  - `handleIncomingSignalingOffer`
  - `acceptCall`
  - `startVoipCall`
  - `ReceivedCall`
  - `AcceptSent`
  - `PreacceptReceived`
  - `wa_call_accept_asymmetric_2`
  - `wa_call_accept_asymmetric() status`

Conclusion:

SOURCE-CONFIRMED: the same local WhatsApp Web VoIP WASM bundle includes a callee path. It is not necessary to invent RTP/SRTP/Opus for the first PoC; the correct next step is invoking `handleIncomingSignalingOffer()` and `acceptCall()`.

UNKNOWN:

- Whether current routing/JID choice is sufficient for all inbound LID/PN/device combinations.
- Whether `acceptCall(true, false)` is enough for every inbound 1:1 voice call or some offers need additional AB props/tokens.

