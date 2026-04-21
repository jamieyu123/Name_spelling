/** AI caller + assistant → confirmation (stdout). OPENAI_API_KEY; CARTISIA_API_KEY for TTS. */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { getCartesiaApiKey, synthesizeCartesiaBytes } from "../lib/cartesia-tts.js";
import { systemPersona, askNamePrompt, replyFormat } from "../lib/prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const MODEL = process.env.SIMULATE_MODEL ?? "gpt-4o-mini";
const dataDir = (locale) => path.join(root, "data", locale);

const CARTESIA_REST = {
  model_id: "sonic-3",
  voice: { mode: "id", id: "86e30c1d-714b-4074-a1f2-1cb6b552fb49" },
  output_format: { container: "wav", encoding: "pcm_f32le", sample_rate: 44100 },
  generation_config: { speed: 1, volume: 1.2, emotion: "neutral" },
  cartesiaVersion: "2025-04-16",
};

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

const stripSsmlBreaks = (s) => s.replace(/<\s*break\b[^>]*\/?\s*>/gi, " ").replace(/\s+/g, " ").trim();

async function cartesiaWavBytes(spoken, locale) {
  return synthesizeCartesiaBytes(stripSsmlBreaks(spoken), {
    modelId: CARTESIA_REST.model_id,
    voice: CARTESIA_REST.voice,
    language: locale === "es" ? "es" : "en",
    apiVersion: CARTESIA_REST.cartesiaVersion,
    outputFormat: CARTESIA_REST.output_format,
    generationConfig: CARTESIA_REST.generation_config,
  });
}

async function chatComplete(openai, messages, temperature) {
  const res = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "none",
    temperature,
    messages,
  });
  return res.choices[0]?.message?.content ?? "";
}

function parseCommandLine(argv) {
  let locale = "en";
  let id = null;
  let writeConfirmationJson = false;
  let writeTtsBatch = false;
  let writeTtsAllLocales = false;
  let outDir = path.join(root, "data");
  let confirmationOut = null;
  let ttsOut = null;
  let ttsOutDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--locale" && argv[i + 1]) locale = argv[++i];
    else if (argv[i] === "--id" && argv[i + 1]) id = argv[++i];
    else if (argv[i] === "--write-confirmation-json") writeConfirmationJson = true;
    else if (argv[i] === "--write-tts-batch") writeTtsBatch = true;
    else if (argv[i] === "--write-tts-all") writeTtsAllLocales = true;
    else if (argv[i] === "--out-dir" && argv[i + 1]) outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--confirmation-out" && argv[i + 1]) confirmationOut = argv[++i];
    else if (argv[i] === "--tts-out" && argv[i + 1]) ttsOut = argv[++i];
    else if (argv[i] === "--tts-out-dir" && argv[i + 1]) ttsOutDir = path.resolve(argv[++i]);
  }
  return { locale, id, outDir, writeConfirmationJson, writeTtsBatch, writeTtsAllLocales, confirmationOut, ttsOut, ttsOutDir };
}

function loadNameEntries(locale) {
  const fileName = locale === "es" ? "test-names.es.json" : "test-names.en.json";
  const data = JSON.parse(fs.readFileSync(path.join(root, "data", fileName), "utf8"));
  return locale === "es" ? data.names : [...data.common, ...data.uncommon];
}

function pickNameEntry(entries, idFromCli) {
  if (idFromCli) {
    const found = entries.find((e) => e.id === idFromCli);
    if (!found) throw new Error(`No name with id "${idFromCli}".`);
    return found;
  }
  return entries[Math.floor(Math.random() * entries.length)];
}

function extractSpokenReply(assistantRawText) {
  const m = assistantRawText.match(/\[reply\]\s*:\s*([\s\S]*?)(?=\n\[|$)/i);
  return (m ? m[1] : assistantRawText).trim();
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

async function runOneSimulation(openai, { locale, id, fullName }, sinks) {
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

async function writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOutFile) {
  const entries = loadNameEntries(locale);
  const sourceFile = locale === "es" ? "test-names.es.json" : "test-names.en.json";
  const outFile = confirmationOutFile
    ? path.isAbsolute(confirmationOutFile)
      ? confirmationOutFile
      : path.join(outDir, confirmationOutFile)
    : path.join(
        outDir,
        locale === "es" ? "simulation-confirmation_sentences.es.json" : "simulation-confirmation_sentences.en.json",
      );
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const payload = { version: 1, locale, source: sourceFile, generatedAt: new Date().toISOString(), entries: [] };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const sentences = [];
    process.stderr.write(`[${i + 1}/${entries.length}] ${entry.id} "${entry.fullName}" …\n`);
    await runOneSimulation(openai, { locale, id: entry.id, fullName: entry.fullName }, {
      log: (s) => sentences.push(s),
      logErr: () => {},
    });
    payload.entries.push({ id: entry.id, fullName: entry.fullName, confirmationSentences: sentences });
  }

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.error(`Wrote ${payload.entries.length} entries to ${outFile}`);
}

async function writeTtsWavForLocale(openai, locale, dir) {
  const entries = loadNameEntries(locale);
  fs.mkdirSync(dir, { recursive: true });
  let wrote = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    process.stderr.write(`[${i + 1}/${entries.length}] ${locale} ${entry.id} "${entry.fullName}" …\n`);
    const spoken = await runOneSimulation(openai, { locale, id: entry.id, fullName: entry.fullName }, {
      log: () => {},
      logErr: () => {},
    });
    if (!spoken?.trim()) {
      console.error(`  skip (empty confirmation): ${entry.id}`);
      continue;
    }
    fs.writeFileSync(path.join(dir, `${entry.id}.wav`), await cartesiaWavBytes(spoken, locale));
    wrote += 1;
  }
  console.error(`Wrote ${wrote} WAV file(s) under ${dir}`);
}

function bail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const {
    locale,
    id: idFromCli,
    outDir,
    writeConfirmationJson,
    writeTtsBatch,
    writeTtsAllLocales,
    confirmationOut,
    ttsOut,
    ttsOutDir,
  } = parseCommandLine(process.argv.slice(2));

  if (!process.env.OPENAI_API_KEY) bail("Missing OPENAI_API_KEY in environment.");

  const anyTts = ttsOut || writeTtsBatch || writeTtsAllLocales;
  if (writeConfirmationJson && anyTts) bail("Cannot combine --write-confirmation-json with TTS flags.");
  if (ttsOut && (writeTtsBatch || writeTtsAllLocales)) bail("Use either --tts-out or batch TTS flags, not both.");
  if (writeTtsBatch && writeTtsAllLocales) bail("Use either --write-tts-batch or --write-tts-all, not both.");
  if (anyTts && !getCartesiaApiKey()) bail("Missing CARTISIA_API_KEY for TTS.");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (writeTtsAllLocales) {
    await writeTtsWavForLocale(openai, "en", dataDir("en"));
    await writeTtsWavForLocale(openai, "es", dataDir("es"));
    return;
  }
  if (writeTtsBatch) {
    await writeTtsWavForLocale(openai, locale, ttsOutDir ?? dataDir(locale));
    return;
  }
  if (writeConfirmationJson) {
    await writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOut);
    return;
  }

  const { id, fullName } = pickNameEntry(loadNameEntries(locale), idFromCli);
  const spoken = await runOneSimulation(openai, { locale, id, fullName }, {
    log: console.log.bind(console),
    logErr: console.error.bind(console),
  });

  if (ttsOut && spoken?.trim()) {
    const outPath = path.resolve(ttsOut);
    const ttsDir = path.dirname(outPath);
    if (ttsDir) fs.mkdirSync(ttsDir, { recursive: true });
    fs.writeFileSync(outPath, await cartesiaWavBytes(spoken, locale));
    console.error(`Wrote TTS → ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
