# Signaling

## Baileys Reject Reference

SOURCE-CONFIRMED upstream Baileys sends:

```xml
<call from="{self}" to="{callFrom}">
  <reject call-id="{callId}" call-creator="{callFrom}" count="0"/>
</call>
```

Important preserved fields:

- `call-id`
- caller JID as `to`
- caller JID as `call-creator`

## baileys-caller Signaling Bridge

SOURCE-CONFIRMED:

- WASM emits binary signaling payloads through `onSignalingXmpp`.
- `SignalingBridge.#doSendSignaling()` decodes payload to a binary node.
- `offer` / `enc_rekey` are encrypted through Baileys Signal repository.
- Non-encrypted call signaling such as `accept`, `transport`, and `terminate` is wrapped in `<call>` and sent with `sendNode()`.
- Server ack is fed back into WASM through `handleSignalingAck()`.

## Inbound Answer Signaling

HYPOTHESIS:

- After `handleIncomingSignalingOffer()`, WASM enters `ReceivedCall`.
- Calling `acceptCall(true, false)` triggers WASM to generate `accept` and transport signaling via the same outbound `onSignalingXmpp` callback.
- Existing `sendSignaling()` should wrap and route those nodes.

Needed experiment:

- Capture logs for `[SIGNAL]` around the generated child tags after `call.answer()`.

