/**
 * Example: auto-answer an inbound voice call and play an audio file after media connects.
 *
 * Usage:
 *   npx tsx examples/inbound-auto-play.mts <authDir> [audioSource]
 *
 * Example:
 *   npx tsx examples/inbound-auto-play.mts ./auth
 */
import { CallState, VoipClient } from "../src/index.mjs";

const defaultAudioSource = [
  "./2026-09-19-190933_148191.mp3",
  "./test.mp3",
].join("|");

const [, , authDir = "./auth", audioSource = defaultAudioSource] = process.argv;

const ts = (): string => new Date().toTimeString().slice(0, 8);
const log = (scope: string, msg: string): void => {
  console.log(`${ts()} [${scope}] ${msg}`);
};

const client = new VoipClient({ authDir });

let callCount = 0;

client.on("incoming-call", async (call) => {
  callCount += 1;
  const n = callCount;
  log("CALL", `#${n} incoming voice call id=${call.callId} from=${call.from ?? "unknown"}`);

  call.on("received", () => log("STATE", `#${n} WASM entered ReceivedCall`));
  call.on("ringing", () => log("STATE", `#${n} ringing / PreacceptReceived`));
  call.on("answering", () => log("STATE", `#${n} answer sent / AcceptSent`));
  call.on("connected", () => log("STATE", `#${n} connected / Active`));
  call.on("audio", (pcm: Float32Array) => log("AUDIO", `#${n} incoming PCM frame samples=${pcm.length}`));
  call.on("ended", (reason: string) => log("CALL", `#${n} ended reason=${reason}; ready for next call`));
  call.on("error", (err: Error) => log("ERROR", `#${n} ${err.message}`));
  if (call.state === CallState.ReceivedCall) {
    log("STATE", `#${n} WASM entered ReceivedCall`);
  }

  try {
    log("CALL", `#${n} answering like first call`);
    await call.answer();
    await call.waitForConnected();
    log("AUDIO", `#${n} playback starting source=${audioSource}`);
    await call.play(audioSource);
    // Tunggu sampai panggilan ini benar-benar selesai sebelum idle.
    // Listener tetap aktif, jadi panggilan berikutnya (telepon kembali)
    // akan dijawab dengan alur yang sama seperti awal.
    await call.waitForEnd();
  } catch (err) {
    log("ERROR", `#${n} ${err instanceof Error ? err.message : String(err)}`);
    try { call.end(); } catch {}
  } finally {
    log("CALL", `#${n} done; waiting for next inbound call`);
  }
});

log("CALL", "connecting");
try {
  await client.connect();
  log("CALL", "connected; waiting for inbound voice call");
} catch (err) {
  if (err instanceof Error) {
    log("ERROR", err.stack ?? err.message);
    const maybeBoom = err as Error & { output?: unknown; data?: unknown };
    if (maybeBoom.output || maybeBoom.data) {
      log("ERROR", `details=${JSON.stringify({
        statusCode: (maybeBoom.output as any)?.statusCode,
        payload: (maybeBoom.output as any)?.payload,
        data: maybeBoom.data,
      })}`);
    }
  } else {
    log("ERROR", String(err));
  }
  process.exit(1);
}
