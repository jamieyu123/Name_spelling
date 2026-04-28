import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/** English — Finch */
export const ELEVENLABS_VOICE_EN = "hFskf6X0TFndppvQxiEF";
/** Spanish — Juan Carlos (es) */
export const ELEVENLABS_VOICE_ES = "YExhVa4bZONzeingloMX";

export const ELEVENLABS_MODEL = "eleven_v3";
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

const LANGUAGE_CODES = new Set(["en", "es"]);

let _client;

/**
 * @param {"en" | "es"} languageCode
 * @returns {string}
 */
export function getElevenLabsVoiceIdForLanguage(languageCode) {
  if (languageCode === "es") return ELEVENLABS_VOICE_ES;
  return ELEVENLABS_VOICE_EN;
}

export function getElevenLabsApiKey() {
  return process.env.ELEVENLABS_API_KEY ?? "";
}

function getElevenLabsClient() {
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY in environment.");
  if (!_client) {
    _client = new ElevenLabsClient({ apiKey });
  }
  return _client;
}

/**
 * TTS as a streaming request (API stream). Await the returned value to get a Web `ReadableStream` of MP3 bytes.
 * Same as `textToSpeech.stream` — use this in production to pipe/forward audio without holding the full buffer.
 * @param {string} text
 * @param {{ languageCode?: "en" | "es" }} [options]
 */
export function streamElevenLabsTts(text, options) {
  const { languageCode = "en" } = options ?? {};
  if (!LANGUAGE_CODES.has(languageCode)) {
    throw new Error(`Invalid languageCode: expected "en" or "es", got ${String(languageCode)}`);
  }
  const voiceId = getElevenLabsVoiceIdForLanguage(languageCode);
  return getElevenLabsClient().textToSpeech.stream(voiceId, {
    text,
    modelId: ELEVENLABS_MODEL,
    outputFormat: ELEVENLABS_OUTPUT_FORMAT,
    languageCode,
  });
}

/** Alias (same as `streamElevenLabsTts`) — name aligned with the ElevenLabs stream pattern. */
export const createAudioStreamFromText = streamElevenLabsTts;

/**
 * Collect streamed MP3 into a single `Buffer` (convenience helper).
 * @param {string} text
 * @param {{ languageCode?: "en" | "es" }} [options]
 * @returns {Promise<Buffer>}
 */
export async function synthesizeElevenLabsBytes(text, options) {
  const stream = await streamElevenLabsTts(text, options);
  return Buffer.from(await new Response(stream).arrayBuffer());
}
