/**
 * Shared name-capture simulation: customer says name → spells → assistant confirmation ([reply]).
 * The customer model sees full dialogue for the spelling turn (opener → name → spell request).
 * Used by scripts/cartesia-tts-test-names.mjs and scripts/elevenlabs-tts-test-names.mjs.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { systemPersona, askNamePrompt, replyFormat } from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MODEL = process.env.SIMULATE_MODEL ?? "gpt-4o-mini";

const ASSISTANT_OPENER_BY_LOCALE = {
  en: "Hi, could I get your first and last name, please?",
  es: "Hola, ¿me puede dar su nombre y apellido, por favor?",
};

const SPELL_REQUEST = {
  en: "Thanks — could you spell your first and last name for me, letter by letter?",
  es: "Gracias — ¿podría deletrear su nombre y apellido, letra por letra?",
};

const SIMULATION_SCOPE_CONFIRM = `This is the continuation of a name-collection call. The caller already gave their spoken name and then spelled it letter by letter. Your ONLY job in this reply is to confirm the spelling in one response, following your name-collection instructions (askNamePrompt). Output exactly one [reply] with that confirmation. Do not ask for more spelling. Do not add a thanks-after-yes (there is no next turn).`;

const SESSION_LANGUAGE_SPANISH = `Session language: Spanish. Write the confirmation in Spanish; spell names using Spanish letter names (nombre de letra: a, be, ce, erre, jota, etc.) — not English letter names or NATO.`;

export function stripSsmlBreaks(s) {
  return s.replace(/<\s*break\b[^>]*\/?\s*>/gi, " ").replace(/\s+/g, " ").trim();
}

function buildCustomerSystemPrompt(fullName, locale) {
  const lang =
    locale === "es"
      ? "Respond in natural Spanish, short (1–3 sentences per turn)."
      : "Respond in natural English, short (1–3 sentences per turn).";
  return [
    `You are the human caller (not the agent).`,
    `Your real full name is exactly: "${fullName}".`,
    lang,
    `If the agent only asks for your name, give your first and last name in words only — do not spell letter-by-letter yet.`,
    `If the agent asks you to spell letter by letter, spell your first name then your last name accurately (letters, dashes, or how you naturally spell aloud).`,
    `Do not say you are an AI.`,
  ].join("\n");
}

function extractSpokenReply(assistantRawText) {
  const m = assistantRawText.match(/\[reply\]\s*:\s*([\s\S]*?)(?=\n\[|$)/i);
  return (m ? m[1] : assistantRawText).trim();
}

async function chatComplete(openai, messages, temperature) {
  // `reasoning_effort` is only for o-series / reasoning models; gpt-4o-mini etc. return 400 if it is sent.
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature,
    messages,
  });
  return res.choices[0]?.message?.content ?? "";
}

/**
 * @param {"en" | "es"} locale
 * @param {{ enHeadEach?: number | null }} [options] If set, English data is only the first N of `common` and first N of `uncommon`.
 */
export function loadNameEntries(locale, options = {}) {
  const { enHeadEach = null } = options;
  const fileName = locale === "es" ? "test-names.es.json" : "test-names.en.json";
  const data = JSON.parse(fs.readFileSync(path.join(root, "data", fileName), "utf8"));
  if (locale === "es") return data.names;
  if (enHeadEach != null) {
    const n = Math.max(0, enHeadEach);
    return [...data.common.slice(0, n), ...data.uncommon.slice(0, n)];
  }
  return [...data.common, ...data.uncommon];
}

export function pickNameEntry(entries, idFromCli) {
  if (idFromCli) {
    const found = entries.find((e) => e.id === idFromCli);
    if (!found) throw new Error(`No name with id "${idFromCli}".`);
    return found;
  }
  return entries[Math.floor(Math.random() * entries.length)];
}

export async function runOneSimulation(openai, { locale, id, fullName }, sinks) {
  const spellRequest = locale === "es" ? SPELL_REQUEST.es : SPELL_REQUEST.en;
  const assistantOpener = ASSISTANT_OPENER_BY_LOCALE[locale] ?? ASSISTANT_OPENER_BY_LOCALE.en;
  const customerSystem = buildCustomerSystemPrompt(fullName, locale);
  const heard = (t) =>
    `The agent just said (this is what you heard on the phone):\n"${t}"\n\nWhat do you say next?`;

  sinks.logErr(`\n=== Simulation: locale=${locale}  id=${id}  name="${fullName}" ===\n`);

  const customerSaysName = await chatComplete(
    openai,
    [
      { role: "system", content: customerSystem },
      { role: "user", content: heard(assistantOpener) },
    ],
    0.7,
  );
  const customerSpells = await chatComplete(
    openai,
    [
      { role: "system", content: customerSystem },
      { role: "user", content: heard(assistantOpener) },
      { role: "assistant", content: customerSaysName },
      { role: "user", content: heard(spellRequest) },
    ],
    0.4,
  );

  const assistantRaw = await chatComplete(
    openai,
    [
      { role: "system", content: systemPersona },
      { role: "system", content: askNamePrompt },
      { role: "system", content: replyFormat },
      ...(locale === "es" ? [{ role: "system", content: SESSION_LANGUAGE_SPANISH }] : []),
      { role: "system", content: SIMULATION_SCOPE_CONFIRM },
      { role: "assistant", content: assistantOpener },
      { role: "user", content: customerSaysName },
      { role: "assistant", content: spellRequest },
      { role: "user", content: customerSpells },
    ],
    0.4,
  );
  const spoken = extractSpokenReply(assistantRaw);

  sinks.log(spoken);
  sinks.logErr("=== Done (fixed flow: name → spell request → spelling → confirmation). ===\n");
  return spoken;
}
