/**
 * Name-call simulation: assistant opens → customer ↔ assistant until:
 *   – previous assistant turn asked to confirm spelling, AND
 *   – customer explicitly says yes / correct (etc.), AND
 *   – assistant replies with a short thanks / acknowledgment → then STOP.
 * Otherwise runs until MAX_TURNS.
 *
 *   1) Prints the assistant opener first (no API call for that line).
 *   2) Customer hears the [reply] line as TTS.
 *
 * Usage:
 *   node scripts/simulate-loop.mjs
 *   node scripts/simulate-loop.mjs --locale es --id es-2
 *   node scripts/simulate-loop.mjs --batch
 *     → runs every id in data/test-names.es.json → data/simulation-results.es.txt
 *       and every id in data/test-names.en.json → data/simulation-results.en.txt
 *
 * Env: OPENAI_API_KEY (required); optional SIMULATE_MODEL, MAX_TURNS
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { systemPersona, askNamePrompt, replyFormat } from "../lib/prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const MODEL = process.env.SIMULATE_MODEL;
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 10);

const ASSISTANT_OPENER = "Hi, could I get your first and last name, please?";

/**
 * Only for this script: after name/spelling is confirmed, do not move to another agenda item.
 */
const SIMULATION_SCOPE = `Simulation scope (strict): Your only job here is to collect and confirm the caller's name. When they have confirmed the spelling is correct, your very next reply must be ONLY a brief thanks in one short sentence (e.g. thanks for confirming). Do not ask what else they need, do not ask how you can help next, do not open a new topic—stop after thanks.`;

// --- helpers -----------------------------------------------------------------

function parseCommandLine(argv) {
  let locale = "en";
  let id = null;
  let batch = false;
  let outDir = path.join(root, "data");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--locale" && argv[i + 1]) locale = argv[++i];
    else if (argv[i] === "--id" && argv[i + 1]) id = argv[++i];
    else if (argv[i] === "--batch") batch = true;
    else if (argv[i] === "--out-dir" && argv[i + 1]) outDir = path.resolve(argv[++i]);
  }
  return { locale, id, batch, outDir };
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

/** Caller only hears the [reply] line (TTS), not [thought]. */
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
    `Give your name when asked. If the agent asks you to spell it, spell it letter by letter accurately.`,
    `If the agent asks whether the spelling is correct, answer with an explicit yes or correct only if it matches your real name.`,
    `Do not say you are an AI.`,
  ].join("\n");
}

function heardAgentPrompt(spokenText) {
  return `The agent just said (this is what you heard on the phone):\n"${spokenText}"\n\nWhat do you say next?`;
}

function assistantAskedSpellingConfirm(spoken) {
  return (
    /is (that|it) (correct|right)\??/i.test(spoken) ||
    /is it\s+[A-Z]/i.test(spoken) ||
    /let me (just )?confirm/i.test(spoken) ||
    /confirm (the )?spelling/i.test(spoken) ||
    /did I get (that|it) (all )?right\??/i.test(spoken) ||
    /sound (alright|right|good)\??/i.test(spoken) ||
    /does that (look|sound) (right|correct)\??/i.test(spoken) ||
    // Spanish: "déjeme confirmar … ¿Es correcto?"
    /d[eé]jeme\s+confirmar/i.test(spoken) ||
    /perm[ií]tame\s+confirmar/i.test(spoken) ||
    /¿?\s*es\s+correcto/i.test(spoken) ||
    /¿?\s*está\s+correcto/i.test(spoken) ||
    // Spanish: "Solo para confirmar la escritura …" / "¿Está bien escrito así?"
    /confirmar\s+la\s+escritura/i.test(spoken) ||
    /está\s+bien\s+escrito/i.test(spoken) ||
    /bien\s+escrito\s+así/i.test(spoken) ||
    /¿?\s*está\s+bien\s+así/i.test(spoken)
  );
}

/** Customer explicitly agrees (after assistant asked to confirm spelling). */
function customerSaysExplicitYes(text) {
  const t = text.trim();
  if (/^\s*(yes|yeah|yep|yup|correct|that'?s right|that'?s correct|exactly)\b/i.test(t)) return true;
  // Spanish sí: do not use \b after sí — JS \b is ASCII-\w only, so "Sí," has no boundary after í
  if (/^\s*s[ií](?:$|[\s,.;:!?]|est(á|a)\s|es\s)/i.test(t)) return true;
  if (/^\s*(correcto|exacto)\b/i.test(t)) return true;
  // e.g. "… es correcto" / "… está correcto"
  if (/\b(es|está)\s+correcto\b/i.test(t)) return true;
  return false;
}

/** Assistant closes with thanks — must pair with prior customer yes + prior confirm ask. */
function assistantSaysThanksAck(spoken) {
  const t = spoken.trim();
  // English + Spanish closings; "perfecto" not matched by ^perfect\b (no boundary before final o)
  if (/^(thanks|thank you|got it|perfecto?|great|awesome|appreciate it|gracias|muy\s+bien)\b/i.test(t))
    return true;
  if (/^(okay|alright),?\s+(thanks|thank you|perfecto?|great)\b/i.test(t)) return true;
  if (/\b(thanks|thank you|gracias),?\s+(I'?ve got|I have|noted|por\s+confirm)/i.test(t)) return true;
  // "Perfect, thanks …" / "Perfecto, gracias …"
  if (/^(perfecto?|great|awesome),?\s+(thanks?|gracias)\b/i.test(t)) return true;
  return false;
}

// --- main --------------------------------------------------------------------

/** @param {{ log: function(string): void, logErr: function(string): void }} sinks */
async function runOneSimulation(openai, { locale, id, fullName }, sinks) {
  const log = sinks.log;
  const logErr = sinks.logErr;

  logErr(`\n=== Simulation: locale=${locale}  id=${id}  name="${fullName}" ===\n`);

  log("--- ASSISTANT (opener) ---");
  log(ASSISTANT_OPENER);
  log("");

  const customerMessages = [
    { role: "system", content: buildCustomerSystemPrompt(fullName, locale) },
    { role: "user", content: heardAgentPrompt(ASSISTANT_OPENER) },
  ];

  const assistantMessages = [
    { role: "system", content: systemPersona },
    { role: "system", content: askNamePrompt },
    { role: "system", content: replyFormat },
    { role: "system", content: SIMULATION_SCOPE },
    { role: "assistant", content: ASSISTANT_OPENER },
  ];

  let previousAssistantAskedConfirm = false;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const custRes = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: "none",
      temperature: 0.7,
      messages: customerMessages,
    });
    const customerText = custRes.choices[0]?.message?.content ?? "";
    customerMessages.push({ role: "assistant", content: customerText });

    const customerAffirmsSpelling =
      previousAssistantAskedConfirm && customerSaysExplicitYes(customerText);

    log(`--- Turn ${turn} · CUSTOMER (caller) ---`);
    log(customerText);
    log("");

    assistantMessages.push({ role: "user", content: customerText });

    const asstRes = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: "none",
      temperature: 0.4,
      messages: assistantMessages,
    });
    const assistantRaw = asstRes.choices[0]?.message?.content ?? "";
    assistantMessages.push({ role: "assistant", content: assistantRaw });

    const spoken = extractSpokenReply(assistantRaw);

    log(`--- Turn ${turn} · ASSISTANT (agent) ---`);
    log(assistantRaw);
    log("");

    if (customerAffirmsSpelling && assistantSaysThanksAck(spoken)) {
      logErr("=== Stopped: customer confirmed spelling; assistant thanked. ===\n");
      return;
    }

    previousAssistantAskedConfirm = assistantAskedSpellingConfirm(spoken);

    customerMessages.push({ role: "user", content: heardAgentPrompt(spoken) });
  }

  logErr(`=== Stopped: reached MAX_TURNS (${MAX_TURNS}) without yes → thanks sequence. ===\n`);
}

async function main() {
  const { locale, id: idFromCli, batch, outDir } = parseCommandLine(process.argv.slice(2));

  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY in environment.");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (batch) {
    fs.mkdirSync(outDir, { recursive: true });
    const sep = "\n\n" + "=".repeat(72) + "\n\n";

    const runLocaleBatch = async (loc) => {
      const entries = loadNameEntries(loc);
      const chunks = [];
      for (const entry of entries) {
        const lines = [];
        await runOneSimulation(openai, { locale: loc, id: entry.id, fullName: entry.fullName }, {
          log: (s) => lines.push(s),
          logErr: (s) => process.stderr.write(s),
        });
        chunks.push(lines.join("\n"));
      }
      const outName = loc === "es" ? "simulation-results.es.txt" : "simulation-results.en.txt";
      const outPath = path.join(outDir, outName);
      fs.writeFileSync(outPath, chunks.join(sep), "utf8");
      console.error(`Wrote ${chunks.length} simulation(s) to ${outPath}`);
    };

    await runLocaleBatch("es");
    await runLocaleBatch("en");
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
