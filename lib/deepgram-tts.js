// Thin wrapper around @deepgram/sdk Aura 2 streaming TTS that returns a
// complete WAV file (44-byte RIFF header + linear16 PCM data) per request.
//
// Streaming-only encodings are linear16/mulaw/alaw with no container, so we
// build the WAV header ourselves once we know the total byte count.

import { DeepgramClient } from "@deepgram/sdk";

const DEFAULT_MODEL_EN = "aura-2-thalia-en";
const DEFAULT_MODEL_ES = "aura-2-celeste-es";
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_TIMEOUT_MS = 30000;

let _client = null;

export function getDeepgramApiKey() {
  return process.env.DEEPGRAM_API_KEY ?? "";
}

function getClient() {
  if (_client) return _client;
  const apiKey = getDeepgramApiKey();
  if (!apiKey) throw new Error("Missing DEEPGRAM_API_KEY in environment.");
  _client = new DeepgramClient({ apiKey });
  return _client;
}

/** @param {"en" | "es"} locale */
export function deepgramVoiceForLocale(locale) {
  if (locale === "es") return process.env.DEEPGRAM_TTS_MODEL_ES ?? DEFAULT_MODEL_ES;
  return process.env.DEEPGRAM_TTS_MODEL_EN ?? DEFAULT_MODEL_EN;
}

function buildWavHeader({ sampleRate, numChannels, bitsPerSample, dataSize }) {
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function isBlob(data) {
  return typeof Blob !== "undefined" && data instanceof Blob;
}

function isAudioFrame(data) {
  return (
    Buffer.isBuffer(data) ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    isBlob(data) ||
    typeof data === "string"
  );
}

async function toAudioBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (isBlob(data)) return Buffer.from(await data.arrayBuffer());
  if (typeof data === "string") return Buffer.from(data, "base64");
  return null;
}

/**
 * Synthesize one piece of text into a complete WAV buffer using Deepgram's
 * Aura 2 streaming WebSocket. Opens a fresh connection per call, sends the
 * text + Flush, collects audio chunks (Blob/Buffer/string), then closes.
 *
 * @param {string} text
 * @param {{ model: string, sampleRate?: number, timeoutMs?: number }} options
 * @returns {Promise<Buffer>} WAV bytes (header + linear16 PCM data)
 */
export async function synthesizeDeepgramWavBytes(text, options) {
  const { model } = options ?? {};
  if (!model) throw new Error("synthesizeDeepgramWavBytes: 'model' is required.");
  const sampleRate = options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const client = getClient();
  const conn = await client.speak.v1.connect({
    model,
    encoding: "linear16",
    sample_rate: String(sampleRate),
    reconnectAttempts: 0,
  });

  return await new Promise((resolve, reject) => {
    /** @type {Array<Promise<Buffer | null>>} */
    const audioChunkPromises = [];
    let settled = false;

    const finalize = async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.close();
      } catch {
        /* noop */
      }
      if (err) {
        reject(err);
        return;
      }
      try {
        const resolved = await Promise.all(audioChunkPromises);
        const data = Buffer.concat(resolved.filter((b) => b && b.length > 0));
        if (data.length === 0) {
          reject(new Error("Deepgram TTS returned no audio data."));
          return;
        }
        const header = buildWavHeader({
          sampleRate,
          numChannels: 1,
          bitsPerSample: 16,
          dataSize: data.length,
        });
        resolve(Buffer.concat([header, data]));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };

    const timer = setTimeout(
      () => finalize(new Error(`Deepgram TTS timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );

    conn.on("error", (err) => finalize(err instanceof Error ? err : new Error(String(err))));

    conn.on("close", () => {
      if (audioChunkPromises.length > 0) finalize();
    });

    conn.on("message", (data) => {
      if (isAudioFrame(data)) {
        audioChunkPromises.push(toAudioBuffer(data));
        return;
      }
      if (data && typeof data === "object") {
        if (data.type === "Flushed") {
          finalize();
          return;
        }
        if (data.type === "Warning") {
          process.stderr.write(`[deepgram warning] ${data.code}: ${data.description}\n`);
        }
      }
    });

    conn.on("open", () => {
      try {
        conn.sendText({ type: "Speak", text });
        conn.sendFlush({ type: "Flush" });
      } catch (err) {
        finalize(err instanceof Error ? err : new Error(String(err)));
      }
    });

    conn.connect();
  });
}
