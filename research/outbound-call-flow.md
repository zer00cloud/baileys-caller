# Outbound Call Flow

SOURCE-CONFIRMED from local `baileys-caller` source.

1. `VoipClient.call(phoneNumber, opts)` normalizes the target PN JID.
2. `SignalingBridge.resolveLid()` resolves the LID for the PN.
3. The client subscribes to presence for PN and LID.
4. `discoverPeerDevices()` obtains device JIDs.
5. `ensureSessionsForPeers()` prepares Signal sessions.
6. `issueTcToken()` / `ensureTcToken()` obtains trusted-contact token data.
7. A call ID is generated.
8. `WasmEngine.startCall()` invokes WASM `startVoipCall(...)`.
9. The WASM emits `onSignalingXmpp` callbacks.
10. `SignalingBridge.sendSignaling()` decodes the WASM binary node, encrypts call keys for `offer` and `enc_rekey`, wraps/sends `<call>` stanzas, and feeds server ACK back via `handleSignalingAck()`.
11. Incoming `<call>` and call `<receipt>` nodes are routed back into WASM.
12. WASM event type `16` carries `call_info.call_state`; state `6` maps to connected.
13. WASM audio capture starts; `AudioFeeder` decodes file/silence to Float32 PCM and calls `onAudioDataFromJs`.
14. WASM audio playback starts; `requestAudioDataFromWasmVoip()` exposes remote PCM.

