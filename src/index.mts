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
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";

import { WasmEngine } from "./wasm-engine.mjs";
import { RelayRtcTransport, type RelayListUpdatePayload } from "./relay-transport.mjs";
import { SignalingBridge } from "./signaling.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { CallState, type VoipSdkConfig } from "./types.mjs";

export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.mjs";
export { CallState } from "./types.mjs";

const SHA256_LEN = 32;
const DEBUG_CALL_LOGS = process.env.DEBUG_CALL_LOGS === "1";
const INBOUND_RECEIVED_TIMEOUT_MS = 8_000;

const debugCall = (scope: string, message: string, data?: unknown): void => {
  if (!DEBUG_CALL_LOGS) return;
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  console.log(`${new Date().toTimeString().slice(0, 8)} [${scope}] ${message}${suffix}`);
};

const loadBaileys = async (): Promise<any> => {
  try {
    return await import("@whiskeysockets/baileys");
  } catch {
    throw new Error(
      "Could not import @whiskeysockets/baileys. Install it as a peer dependency.",
    );
  }
};

const toBareJid = (jid: string): string => {
  if (!jid) return jid;
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0];
  return `${user}@${jid.slice(at + 1)}`;
};

const computeHkdf = (
  key: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array,
  length: number,
): Uint8Array => {
  const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
  const prk = createHmac("sha256", effectiveSalt).update(key).digest();
  const blocks = Math.ceil(length / SHA256_LEN);
  const okm = Buffer.alloc(blocks * SHA256_LEN);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i += 1) {
    prev = createHmac("sha256", prk)
      .update(prev)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    prev.copy(okm, (i - 1) * SHA256_LEN);
  }
  return new Uint8Array(okm.buffer, okm.byteOffset, length);
};

const computeHmacSha256 = (data: Uint8Array, key: Uint8Array): Uint8Array => {
  const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};

const isCallReceiptNode = (node: any): boolean => {
  if (node?.tag !== "receipt") return false;
  const child = Array.isArray(node.content) ? node.content[0] : null;
  return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};

const getNodeChildren = (node: any): any[] =>
  Array.isArray(node?.content) ? node.content : [];

const getFirstNodeChild = (node: any): any | undefined =>
  getNodeChildren(node).find((child) => child?.tag);

const extractIncomingOffer = (node: any): {
  callId: string;
  from: string;
  chatId: string;
  isVideo: boolean;
} | undefined => {
  if (node?.tag !== "call") return undefined;
  const child = getFirstNodeChild(node);
  if (child?.tag !== "offer") return undefined;
  const callId = String(child.attrs?.["call-id"] ?? child.attrs?.call_id ?? "");
  const from = String(
    child.attrs?.from ??
    child.attrs?.["call-creator"] ??
    child.attrs?.participant ??
    node.attrs?.participant ??
    node.attrs?.from ??
    "",
  );
  if (!callId || !from) return undefined;
  return {
    callId,
    from,
    chatId: String(node.attrs?.from ?? from),
    isVideo: getNodeChildren(child).some((nested) => nested?.tag === "video"),
  };
};

/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
  #state: CallState = CallState.Idle;
  #endResolver!: (reason: string) => void;
  #receivedResolver!: () => void;
  #connectedResolver!: () => void;
  readonly #endPromise: Promise<string>;
  readonly #receivedPromise: Promise<void>;
  readonly #connectedPromise: Promise<void>;
  #endTimer: NodeJS.Timeout | null = null;
  #ended = false;
  #endEmitted = false;

  /** @internal mirrors the source path for the audio feeder */
  _audioSource: string = "silence";

  constructor(
    public readonly callId: string,
    private readonly engine: WasmEngine,
    durationMs: number,
    public readonly direction: "outbound" | "inbound" = "outbound",
    public readonly from?: string,
  ) {
    super();
    this.#endPromise = new Promise((res) => { this.#endResolver = res; });
    this.#receivedPromise = new Promise((res) => { this.#receivedResolver = res; });
    this.#connectedPromise = new Promise((res) => { this.#connectedResolver = res; });
    if (durationMs > 0) {
      this.#endTimer = setTimeout(() => this.end(), durationMs);
    }
  }

  get state(): CallState { return this.#state; }

  end = (reason = "ended"): void => {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    try { this.engine.endCall(0, true); } catch {}
    // Jangan tunggu state Idle/Ending dari WASM saja — WASM kadang tidak
    // mengirim state terminal setelah end() lokal, sehingga panggilan
    // berikutnya tertahan. Paksa emit ended agar client bisa reset.
    this._forceEnd(reason);
  };

  mute = (muted: boolean): void => {
    try { this.engine.setMute(muted); } catch {}
  };

  answer = async (opts: { mic?: boolean; camera?: boolean } = {}): Promise<void> => {
    if (this.direction !== "inbound") {
      throw new Error("answer() is only valid for inbound calls");
    }
    if (this.#state !== CallState.ReceivedCall) {
      await Promise.race([
        this.#receivedPromise,
        this.#endPromise.then((reason) => {
          throw new Error(`Call ended before it could be answered: ${reason}`);
        }),
      ]);
    }
    debugCall("CALL-TX", "answer", { callId: this.callId });
    const result = this.engine.acceptCall(opts.mic ?? true, opts.camera ?? false);
    debugCall("WASM", "acceptCall returned", { result });
  };

  play = async (audioSource: string): Promise<void> => {
    this._audioSource = audioSource;
    this.emit("playSource", audioSource);
  };

  waitForConnected = (): Promise<void> => {
    if (this.#state === CallState.Active) return Promise.resolve();
    return Promise.race([
      this.#connectedPromise,
      this.#endPromise.then((reason) => {
        throw new Error(`Call ended before connecting: ${reason}`);
      }),
    ]);
  };

  waitForEnd = (): Promise<string> => this.#endPromise;

  /** @internal */
  _waitForReceived = (timeoutMs: number): Promise<void> => {
    if (this.#state === CallState.ReceivedCall || this.#state === CallState.AcceptSent || this.#state === CallState.Active) {
      return Promise.resolve();
    }
    return Promise.race([
      this.#receivedPromise,
      this.#endPromise.then((reason) => {
        throw new Error(`Call ended before it could be answered: ${reason}`);
      }),
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error(`Timed out waiting for inbound call to become answerable`)), timeoutMs);
      }),
    ]);
  };

  /** @internal — called by VoipClient on WASM call-state change */
  _updateState = (state: number): void => {
    this.#state = state as CallState;
    if (state === CallState.PreacceptReceived) this.emit("ringing");
    else if (state === CallState.ReceivedCall) {
      debugCall("CALL-STATE", "answerable", {
        callId: this.callId,
        offerReceived: true,
        peerResolved: true,
        deviceResolved: true,
        sessionReady: true,
        answerable: true,
      });
      this.emit("received");
      this.#receivedResolver();
    }
    else if (state === CallState.AcceptSent) {
      debugCall("CALL", "answer sent", { callId: this.callId });
      this.emit("answering");
    }
    else if (state === CallState.Active) {
      debugCall("CALL", "answered", { callId: this.callId });
      this.emit("connected");
      this.#connectedResolver();
    }
    else if (state === CallState.Idle || state === CallState.Ending) {
      this._forceEnd("ended");
    }
  };

  /** @internal */
  _emitAudio = (pcm: Float32Array): void => { this.emit("audio", pcm); };

  /** @internal */
  _forceEnd = (reason: string): void => {
    if (this.#endEmitted) return;
    this.#endEmitted = true;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    this.emit("ended", reason);
    this.#endResolver(reason);
  };
}

/** Top-level client. Connects to WhatsApp and lets you place calls. */
export class VoipClient extends EventEmitter {
  readonly #config: VoipSdkConfig;
  #engine: WasmEngine | null = null;
  #relay: RelayRtcTransport | null = null;
  #signaling: SignalingBridge | null = null;
  #sock: any = null;
  #activeCall: ActiveCall | null = null;
  #baileys: any = null;

  // Capture state populated when WASM negotiates audio params
  #capturePtr = 0;
  #captureChunkBytes = 0;
  #captureSampleRate = 16000;
  #captureChannels = 1;
  #captureFramesPerChunk = 320;
  #feeder: AudioFeeder | null = null;

  constructor(config: VoipSdkConfig) {
    super();
    this.#config = config;
  }

  /** Connect to WhatsApp and bring up the WASM VoIP stack. */
  connect = async (): Promise<void> => {
    this.#baileys = await loadBaileys();
    const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
    const makeSocket: (opts: any) => any =
      makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;

    const authDir = resolve(this.#config.authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const silentLogger: any = {
      level: "silent",
      child: () => silentLogger,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    let waVersion: any = undefined;
    try {
      const latest = await this.#baileys.fetchLatestWaWebVersion?.();
      if (latest?.version) waVersion = latest.version;
    } catch {}

    const createSocket = () => makeSocket({
      auth: state,
      emitOwnEvents: true,
      logger: silentLogger,
      ...(waVersion ? { version: waVersion } : {}),
    });

    // Connect with auto-reconnect on the post-QR 515 stream-error path.
    await new Promise<void>((resolveOpen, rejectOpen) => {
      let opened = false;
      let retries = 0;
      const maxRetries = 5;

      const connectSocket = () => {
        this.#sock = createSocket();
        this.#sock.ev.on("creds.update", saveCreds);

        process.removeAllListeners("uncaughtException");
        process.on("uncaughtException", (err: any) => {
          const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
          if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
            retries += 1;
            setTimeout(connectSocket, 1500);
          } else if (!opened) {
            rejectOpen(err);
          }
        });

        this.#sock.ev.on("connection.update", (update: any) => {
          if (update.qr) {
            void import("qrcode-terminal")
              .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
              .catch(() => {
                console.log("Scan this QR code in WhatsApp > Linked Devices:");
                console.log(update.qr);
              });
          }
          if (update.connection === "open") {
            opened = true;
            process.removeAllListeners("uncaughtException");
            resolveOpen();
            return;
          }
          if (update.connection === "close" && !opened) {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect =
              statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
            if (shouldReconnect && retries < maxRetries) {
              retries += 1;
              setTimeout(connectSocket, 1000);
            } else {
              rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
            }
          }
        });
      };

      connectSocket();
    });

    this.#signaling = new SignalingBridge({ sock: this.#sock });
    await this.#signaling.init();

    this.#relay = new RelayRtcTransport({
      onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
      onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
    });

    this.#engine = new WasmEngine({
      callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) =>
          this.#signaling!.sendSignaling(peerJid, callId, xmlPayload),
        onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
        sendDataToRelay: (data, ip, port) => this.#relay!.send(data, ip, port),
        onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
        onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
        onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
        onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
        cryptoHkdf: computeHkdf,
        hmacSha256: computeHmacSha256,
      },
    });

    await this.#engine.initialize();
    this.#signaling.attachEngine(this.#engine);

    const selfPnJid = this.#sock.authState.creds.me?.id;
    const selfLidJid = this.#sock.authState.creds.me?.lid;
    this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
    await this.#engine.waitForVoipStackReady();
    try { this.#engine.updateNetworkMedium(2, 0); } catch {}

    this.#sock.ws.on("CB:call", (node: any) => {
      void this.#handleIncomingCallNode(node);
    });
    this.#sock.ws.on("CB:receipt", (node: any) => {
      if (!isCallReceiptNode(node)) return;
      void this.#signaling!.processIncomingReceipt(node, this.#engine!, this.#activeCall?.callId ?? "");
    });
  };

  /** Place an outbound voice call. */
  call = async (
    phoneNumber: string,
    opts: { audioSource?: string; durationMs?: number } = {},
  ): Promise<ActiveCall> => {
    if (!this.#engine || !this.#signaling) throw new Error("Not connected. Call connect() first.");
    if (this.#activeCall) throw new Error("A call is already active.");

    const targetNumber = phoneNumber.replace(/\D/g, "");
    const targetPnJid = `${targetNumber}@s.whatsapp.net`;
    const durationMs = opts.durationMs ?? 120_000;
    const audioSource = opts.audioSource ?? "silence";

    const peerLid = await this.#signaling.resolveLid(targetPnJid);
    if (!peerLid) throw new Error(`Could not resolve LID for ${targetPnJid}`);

    for (const jid of [targetPnJid, peerLid]) {
      try { await this.#sock.presenceSubscribe(jid); } catch {}
    }
    await new Promise((r) => setTimeout(r, 750));

    const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
    const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];

    await this.#signaling.ensureSessionsForPeers(deviceList);

    await new Promise((r) => setTimeout(r, 500));
    await this.#signaling.issueTcToken(peerLid);
    const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);

    const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();

    const call = new ActiveCall(callId, this.#engine, durationMs, "outbound");
    this.#wireActiveCall(call);
    call._audioSource = audioSource;
    this.#activeCall = call;
    try { this.#relay?.noteCallStarted(); } catch {}

    this.#engine.startCall({
      peerJid: peerLid,
      peerPn: targetPnJid,
      peerList: deviceList,
      callId,
      isVideo: false,
      isLidCall: true,
      isFromDialer: false,
      extraData: tcToken,
    });

    return call;
  };

  /** Tear down the WhatsApp socket and release resources. */
  disconnect = (): void => {
    try { this.#activeCall?._forceEnd("disconnect"); } catch {}
    this.#activeCall = null;
    this.#resetCallMedia();
    if (this.#engine && this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
      this.#capturePtr = 0;
    }
    this.#relay?.closeAll();
    this.#engine?.destroy();
    this.#sock?.end?.();
    this.#engine = null;
    this.#relay = null;
    this.#signaling = null;
    this.#sock = null;
  };

  // ─── private ──────────────────────────────────────────────────────────────

  #handleIncomingCallNode = async (node: any): Promise<void> => {
    if (!this.#engine || !this.#signaling) return;

    const offer = extractIncomingOffer(node);
    let callToEmit: ActiveCall | null = null;
    if (offer) {
      // Jika panggilan lama sudah selesai (Idle/Ending) tapi objeknya belum
      // dibersihkan karena race, paksa tutup agar panggilan baru bisa masuk.
      const stale = this.#activeCall;
      if (stale && stale.callId !== offer.callId &&
          (stale.state === CallState.Idle || stale.state === CallState.Ending)) {
        try { stale._forceEnd("ended"); } catch {}
        this.#resetCallMedia();
        this.#signaling.clearCallState(stale.callId);
        this.#activeCall = null;
      }
      if (!this.#activeCall) {
        const call = new ActiveCall(offer.callId, this.#engine, 120_000, "inbound", offer.from);
        call._audioSource = "silence";
        this.#wireActiveCall(call);
        this.#activeCall = call;
        callToEmit = call;
        // Reset flag media relay untuk panggilan baru (cegah ICE-restart
        // palsu / stall setelah 3-4 panggilan beruntun).
        try { this.#relay?.noteCallStarted(); } catch {}
      }
    }

    await this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");

    if (callToEmit) {
      try {
        await callToEmit._waitForReceived(INBOUND_RECEIVED_TIMEOUT_MS);
        this.emit("incoming-call", callToEmit);
      } catch (err) {
        debugCall("CALL", "incoming offer did not become answerable", {
          callId: callToEmit.callId,
          from: callToEmit.from,
          error: err instanceof Error ? err.message : String(err),
        });
        try { callToEmit._forceEnd("not_answerable"); } catch {}
        if (this.#activeCall === callToEmit) {
          this.#resetCallMedia();
          try { this.#relay?.noteCallEnded(); } catch {}
          try { this.#signaling?.clearCallState(callToEmit.callId); } catch {}
          this.#activeCall = null;
        }
      }
    }
  };

  #resetCallMedia = (): void => {
    try { this.#feeder?.stop(); } catch {}
    this.#feeder = null;
    // Jangan free capturePtr di sini — itu tugas onAudioCaptureStop dari WASM.
    // Tapi pastikan feeder berhenti agar panggilan berikutnya mulai bersih.
  };

  #wireActiveCall = (call: ActiveCall): void => {
    call.on("playSource", (audioSource: string) => {
      if (this.#activeCall !== call) return;
      if (!this.#engine) return;
      this.#feeder?.stop();
      if (!this.#capturePtr) {
        const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
        this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
        debugCall("AUDIO", "manual capture buffer allocated", {
          bytes: this.#captureChunkBytes,
          sampleRate: this.#captureSampleRate,
          channels: this.#captureChannels,
          framesPerChunk: this.#captureFramesPerChunk,
        });
      }
      if (!this.#capturePtr) return;
      this.#feeder = this.#createAudioFeeder(audioSource);
      this.#feeder.start();
    });
    call.once("ended", () => {
      if (this.#activeCall === call) {
        this.#resetCallMedia();
        try { this.#relay?.noteCallEnded(); } catch {}
        try { this.#signaling?.clearCallState(call.callId); } catch {}
        this.#activeCall = null;
        debugCall("CALL", "active call cleared, ready for next call", { callId: call.callId });
      }
    });
  };

  #handleCallEvent = (eventType: number, eventData?: string): void => {
    if (eventType !== 100 && eventType !== 92) {
      debugCall("WASM", "call event", { eventType, eventData });
    }
    if (eventType === 16 && eventData) {
      try {
        const parsed = JSON.parse(eventData);
        const info = parsed.call_info ?? parsed.callInfo ?? {};
        const callState = Number(info.call_state ?? info.callState ?? 0);
        debugCall("STATE", "call state", { callState, info });
        this.#activeCall?._updateState(callState);
      } catch {}
    } else if (eventType === 156 && eventData) {
      try {
        const update = JSON.parse(eventData) as RelayListUpdatePayload;
        this.#relay?.updateRelayList(update);
      } catch {}
    } else if (eventType === 2) {
      debugCall("WASM", "remote end-like event ignored until terminal state", { eventType, eventData });
    }
  };

  #handleAudioCaptureInit = (config: {
    sampleRate: number; channels: number; bitsPerSample: number; framesPerChunk: number;
  }): void => {
    if (!this.#engine) return;
    debugCall("AUDIO", "capture init", config);
    this.#captureSampleRate = config.sampleRate || 16000;
    this.#captureChannels = config.channels || 1;
    this.#captureFramesPerChunk = config.framesPerChunk || 320;
    const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
    this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    // Panggilan kedua bisa memicu init ulang tanpa stop yang bersih —
    // bebaskan buffer lama dulu agar tidak bocor / double-alloc.
    if (this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
      this.#capturePtr = 0;
    }
    this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
  };

  #handleAudioCaptureStart = (): void => {
    if (!this.#engine) return;
    // Panggilan kedua kadang start tanpa init baru (ptr sudah di-free
    // oleh stop sebelumnya). Alokasikan ulang agar feeder tetap jalan.
    if (!this.#capturePtr) {
      const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
      this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
      this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
      debugCall("AUDIO", "capture buffer re-allocated on start", {
        bytes: this.#captureChunkBytes,
      });
    }
    if (!this.#capturePtr) return;
    // Hentikan feeder sisa panggilan sebelumnya agar tidak dobel.
    try { this.#feeder?.stop(); } catch {}
    this.#feeder = null;
    const audioSource = this.#activeCall?._audioSource ?? "silence";
    debugCall("AUDIO", "capture start", {
      audioSource,
      sampleRate: this.#captureSampleRate,
      channels: this.#captureChannels,
      framesPerChunk: this.#captureFramesPerChunk,
    });
    this.#feeder = this.#createAudioFeeder(audioSource);
    this.#feeder.start();
  };

  #handleAudioCaptureStop = (): void => {
    debugCall("AUDIO", "capture stop");
    this.#feeder?.stop();
    this.#feeder = null;
    if (this.#engine && this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
      this.#capturePtr = 0;
    }
  };

  #createAudioFeeder = (audioSource: string): AudioFeeder =>
    (debugCall("AUDIO", "create feeder", {
      audioSource,
      sampleRate: this.#captureSampleRate,
      channels: this.#captureChannels,
      framesPerChunk: this.#captureFramesPerChunk,
    }), new AudioFeeder(
      this.#captureSampleRate,
      this.#captureChannels,
      this.#captureFramesPerChunk,
      (chunk) => {
        if (this.#engine && this.#capturePtr) this.#engine.sendAudioData(chunk, this.#capturePtr);
      },
      audioSource,
    ));
}
