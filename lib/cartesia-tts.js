const API_BASE = "https://api.cartesia.ai";

/** English — Carson */
export const CARTESIA_VOICE_ID_EN = "86e30c1d-714b-4074-a1f2-1cb6b552fb49";
/** Spanish */
export const CARTESIA_VOICE_ID_ES = "2695b6b5-5543-4be1-96d9-3967fb5e7fec";

/** @param {"en" | "es"} locale */
export function cartesiaVoiceForLocale(locale) {
  const id = locale === "es" ? CARTESIA_VOICE_ID_ES : CARTESIA_VOICE_ID_EN;
  return { mode: "id", id };
}

export function getCartesiaApiKey() {
  return process.env.CARTISIA_API_KEY ?? "";
}

export async function synthesizeCartesiaBytes(transcript, options) {
  const apiKey = getCartesiaApiKey();
  if (!apiKey) throw new Error("Missing CARTISIA_API_KEY in environment.");
  const { modelId, voice, language, apiVersion, outputFormat, generationConfig } = options;
  const res = await fetch(`${API_BASE}/tts/bytes`, {
    method: "POST",
    headers: {
      "Cartesia-Version": apiVersion,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: modelId,
      transcript,
      voice,
      language,
      output_format: outputFormat,
      generation_config: generationConfig,
    }),
  });
  if (!res.ok) throw new Error(`Cartesia TTS failed (${res.status}): ${(await res.text()).slice(0, 800)}`);
  return Buffer.from(await res.arrayBuffer());
}
