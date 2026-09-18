import { VoipClient } from "../dist/index.mjs";

const [, , authDir = "./auth", audioSource = "./test.mp3"] = process.argv;

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (scope, msg) => {
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
  call.on("audio", (pcm) => log("AUDIO", `#${n} incoming PCM frame samples=${pcm.length}`));
  call.on("ended", (reason) => log("CALL", `#${n} ended reason=${reason}; ready for next call`));
  call.on("error", (err) => log("ERROR", `#${n} ${err.message}`));

  try {
    log("CALL", `#${n} answering like first call`);
    await call.answer();
    await call.waitForConnected();
    log("AUDIO", `#${n} playback starting source=${audioSource}`);
    await call.play(audioSource);
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
    const maybeBoom = err;
    if (maybeBoom.output || maybeBoom.data) {
      log("ERROR", `details=${JSON.stringify({
        statusCode: maybeBoom.output?.statusCode,
        payload: maybeBoom.output?.payload,
        data: maybeBoom.data,
      })}`);
    }
  } else {
    log("ERROR", String(err));
  }
  process.exit(1);
}
