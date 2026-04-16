/**
 * Fixed short simulation: AI caller (name from test-names.en.json or test-names.es.json) + AI assistant.
 *
 * Turns (no loop, no MAX_TURNS):
 *   1) Assistant opener (fixed): "Hi, could I get your first and last name, please?"
 *   2) AI customer: says the name from JSON (spoken, no letter-by-letter yet)
 *   3) Assistant spell request (fixed string, not generated): ask to spell first and last letter by letter
 *   4) AI customer: spells the name
 *   5) AI assistant: one reply = spelling confirmation per askNamePrompt → stdout is that sentence only
 *
 * Usage: node scripts/simulate-loop.mjs [--locale es|en] [--id …] | --write-confirmation-json [--locale es|en] [--out-dir …] [--confirmation-out <filename>]
 * Confirmation JSON always uses askNamePrompt from ../lib/prompts.js (current file).
 * Default output: data/simulation-confirmation_sentences.en.json or .es.json. Override: --confirmation-out simulation-confirmation_sentences-old-prompt.en.json
 * Env: OPENAI_API_KEY; optional SIMULATE_MODEL (default gpt-4o-mini)
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { systemPersona, askNamePrompt, replyFormat } from "../lib/prompts.js";

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

/** Last assistant turn: only produce the confirmation line; no extra turns after. */
const SIMULATION_SCOPE_CONFIRM = `This is the continuation of a name-collection call. The caller already gave their spoken name and then spelled it letter by letter. Your ONLY job in this reply is to confirm the spelling in one response, following your name-collection instructions (askNamePrompt). Output exactly one [reply] with that confirmation. Do not ask for more spelling. Do not add a thanks-after-yes (there is no next turn).`;

const SESSION_LANGUAGE_SPANISH = `Session language: Spanish. Write the confirmation in Spanish; spell names using Spanish letter names (nombre de letra: a, be, ce, erre, jota, etc.) — not English letter names or NATO.`;

function parseCommandLine(argv) {
  let locale = "en";
  let id = null;
  let writeConfirmationJson = false;
  let outDir = path.join(root, "data");
  /** Optional output basename or path for --write-confirmation-json (default: simulation-confirmation_sentences.<locale>.json). */
  let confirmationOut = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--locale" && argv[i + 1]) {
      locale = argv[++i];
    } else if (argv[i] === "--id" && argv[i + 1]) id = argv[++i];
    else if (argv[i] === "--write-confirmation-json") writeConfirmationJson = true;
    else if (argv[i] === "--out-dir" && argv[i + 1]) outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--confirmation-out" && argv[i + 1]) confirmationOut = argv[++i];
  }
  return { locale, id, outDir, writeConfirmationJson, confirmationOut };
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

function heardAgentPrompt(spokenText) {
  return `The agent just said (this is what you heard on the phone):\n"${spokenText}"\n\nWhat do you say next?`;
}

async function runOneSimulation(openai, { locale, id, fullName }, sinks) {
  const log = sinks.log;
  const logErr = sinks.logErr;
  const spellRequest = locale === "es" ? SPELL_REQUEST.es : SPELL_REQUEST.en;
  const assistantOpener = ASSISTANT_OPENER_BY_LOCALE[locale] ?? ASSISTANT_OPENER_BY_LOCALE.en;

  logErr(`\n=== Simulation: locale=${locale}  id=${id}  name="${fullName}" ===\n`);

  const customerSystem = buildCustomerSystemPrompt(fullName, locale);

  const cust1 = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "none",
    temperature: 0.7,
    messages: [
      { role: "system", content: customerSystem },
      { role: "user", content: heardAgentPrompt(assistantOpener) },
    ],
  });
  const customerSaysName = cust1.choices[0]?.message?.content ?? "";

  const cust2 = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "none",
    temperature: 0.4,
    messages: [
      { role: "system", content: customerSystem },
      { role: "user", content: heardAgentPrompt(spellRequest) },
    ],
  });
  const customerSpells = cust2.choices[0]?.message?.content ?? "";

  const assistantSystemMessages = [
    { role: "system", content: systemPersona },
    { role: "system", content: askNamePrompt },
    { role: "system", content: replyFormat },
    ...(locale === "es" ? [{ role: "system", content: SESSION_LANGUAGE_SPANISH }] : []),
    { role: "system", content: SIMULATION_SCOPE_CONFIRM },
    { role: "assistant", content: assistantOpener },
    { role: "user", content: customerSaysName },
    { role: "assistant", content: spellRequest },
    { role: "user", content: customerSpells },
  ];

  const asstRes = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: "none",
    temperature: 0.4,
    messages: assistantSystemMessages,
  });
  const assistantRaw = asstRes.choices[0]?.message?.content ?? "";
  const spoken = extractSpokenReply(assistantRaw);

  log(spoken);
  logErr("=== Done (fixed flow: name → spell request → spelling → confirmation). ===\n");
}

function defaultConfirmationJsonName(locale) {
  return locale === "es" ? "simulation-confirmation_sentences.es.json" : "simulation-confirmation_sentences.en.json";
}

async function writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOutFile) {
  const entries = loadNameEntries(locale);
  const sourceFile = locale === "es" ? "test-names.es.json" : "test-names.en.json";
  const outFile = confirmationOutFile
    ? path.isAbsolute(confirmationOutFile)
      ? confirmationOutFile
      : path.join(outDir, confirmationOutFile)
    : path.join(outDir, defaultConfirmationJsonName(locale));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const payload = {
    version: 1,
    locale,
    source: sourceFile,
    generatedAt: new Date().toISOString(),
    entries: [],
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const sentences = [];
    process.stderr.write(`[${i + 1}/${entries.length}] ${entry.id} "${entry.fullName}" …\n`);
    await runOneSimulation(openai, { locale, id: entry.id, fullName: entry.fullName }, {
      log: (s) => sentences.push(s),
      logErr: () => {},
    });
    payload.entries.push({
      id: entry.id,
      fullName: entry.fullName,
      confirmationSentences: sentences,
    });
  }

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.error(`Wrote ${payload.entries.length} entries to ${outFile}`);
}

async function main() {
  const { locale, id: idFromCli, outDir, writeConfirmationJson, confirmationOut } = parseCommandLine(
    process.argv.slice(2),
  );

  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY in environment.");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (writeConfirmationJson) {
    await writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOut);
    return;
  }

  const { id, fullName } = pickNameEntry(loadNameEntries(locale), idFromCli);

  await runOneSimulation(openai, { locale, id, fullName }, {
    log: console.log.bind(console),
    logErr: console.error.bind(console),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
