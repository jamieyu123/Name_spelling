import "dotenv/config";
import { DeepgramClient } from "@deepgram/sdk";

const text = process.argv[2] || "Let me confirm: J-A-M-E-S, S-M-I-T-H. Is that correct?";
const client = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
const conn = await client.speak.v1.connect({
  model: "aura-2-thalia-en",
  encoding: "linear16",
  sample_rate: "24000",
  reconnectAttempts: 0,
});

let audioBytes = 0;
let audioFrames = 0;
let flushedAt = null;
let lastFrameAt = null;
const start = Date.now();

const log = (m) => process.stdout.write(`[+${Date.now() - start}ms] ${m}\n`);

conn.on("open", () => {
  log(`open; sending Speak (${text.length} chars) + Flush`);
  conn.sendText({ type: "Speak", text });
  conn.sendFlush({ type: "Flush" });
});

conn.on("message", (data) => {
  if (data && typeof data === "object" && data.type) {
    log(`json msg: ${JSON.stringify(data)}`);
    if (data.type === "Flushed") {
      flushedAt = Date.now() - start;
    }
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    audioFrames += 1;
    audioBytes += data.size;
    lastFrameAt = Date.now() - start;
  } else {
    log(`other: type=${data?.constructor?.name ?? typeof data}`);
  }
});

conn.on("error", (err) => log(`error: ${err?.message || err}`));

conn.on("close", () => {
  log(`close; audioFrames=${audioFrames} audioBytes=${audioBytes} flushedAt=${flushedAt} lastFrameAt=${lastFrameAt} duration=${(audioBytes / 48000).toFixed(2)}s`);
  process.exit(0);
});

conn.connect();

setTimeout(() => {
  log(`reached external 20s timeout; gracefully closing`);
  conn.sendClose({ type: "Close" });
  setTimeout(() => { try { conn.close(); } catch {} setTimeout(() => process.exit(2), 500); }, 1500);
}, 20000);
