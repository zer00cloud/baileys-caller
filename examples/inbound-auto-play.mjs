import { VoipClient } from "../dist/index.mjs";

const [, , authDir = "./auth", audioSource = "./test.mp3"] = process.argv;

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (scope, msg) => {
  console.log(`${ts()} [${scope}] ${msg}`);
};

const client = new VoipClient({ authDir });

client.on("incoming-call", async (call) => {
  log("CALL", `incoming voice call id=${call.callId} from=${call.from ?? "unknown"}`);

  call.on("received", () => log("STATE", "WASM entered ReceivedCall"));
  call.on("answering", () => log("STATE", "answer sent / AcceptSent"));
  call.on("connected", () => log("STATE", "connected / Active"));
  call.on("audio", (pcm) => log("AUDIO", `incoming PCM frame samples=${pcm.length}`));
  call.on("ended", (reason) => log("CALL", `ended reason=${reason}`));
  call.on("error", (err) => log("ERROR", err.message));

  try {
    log("CALL", "answering");
    await call.answer();
    await call.waitForConnected();
    log("AUDIO", `playback starting source=${audioSource}`);
    await call.play(audioSource);
  } catch (err) {
    log("ERROR", err instanceof Error ? err.message : String(err));
    call.end();
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
