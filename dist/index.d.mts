/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { WasmEngine } from "./wasm-engine.mjs";
import { CallState, type VoipSdkConfig } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.mjs";
export { CallState } from "./types.mjs";
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    readonly direction: "outbound" | "inbound";
    readonly from?: string | undefined;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    constructor(callId: string, engine: WasmEngine, durationMs: number, direction?: "outbound" | "inbound", from?: string | undefined);
    get state(): CallState;
    end: (reason?: string) => void;
    mute: (muted: boolean) => void;
    answer: (opts?: {
        mic?: boolean;
        camera?: boolean;
    }) => Promise<void>;
    play: (audioSource: string) => Promise<void>;
    waitForConnected: () => Promise<void>;
    waitForEnd: () => Promise<string>;
    /** @internal */
    _waitForReceived: (timeoutMs: number) => Promise<void>;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /** @internal */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
}
/** Top-level client. Connects to WhatsApp and lets you place calls. */
export declare class VoipClient extends EventEmitter {
    #private;
    constructor(config: VoipSdkConfig);
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect: () => Promise<void>;
    /** Place an outbound voice call. */
    call: (phoneNumber: string, opts?: {
        audioSource?: string;
        durationMs?: number;
    }) => Promise<ActiveCall>;
    /** Tear down the WhatsApp socket and release resources. */
    disconnect: () => void;
}
