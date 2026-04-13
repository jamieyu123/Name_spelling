/**
 * Name-call simulation: confirm question → customer yes → assistant thanks → STOP (see assistantSaysThanksAck).
 * Spell-only prompts (deletrear, etc.) do not complete the sequence until a yes/no confirm appears. MAX_TURNS otherwise.
 * Prints opener first (no API); caller hears [reply] as TTS.
 *
 * Usage:
 *   node scripts/simulate-loop.mjs
 *   node scripts/simulate-loop.mjs --locale es --id es-2
 *   node scripts/simulate-loop.mjs --batch
 *     → runs every id in data/test-names.es.json → data/simulation-results.es.txt
 *       and every id in data/test-names.en.json → data/simulation-results.en.txt
 *   node scripts/simulate-loop.mjs --batch --locale es
 *     → Spanish batch only (rewrites simulation-results.es.txt)
 *   node scripts/simulate-loop.mjs --batch --locale en
 *     → English batch only (rewrites simulation-results.en.txt)
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
const SIMULATION_SCOPE = `Simulation scope (strict): Your only job is to collect and confirm the caller's name. When they confirm the spelling is correct, your very next reply must be ONLY one short sentence of thanks (e.g. thanks for confirming the name). No follow-up questions, no "anything else I can help with", no goodbyes that reopen the topic, no apologies for silence—one thanks sentence and the name task is done.`;

function parseCommandLine(argv) {
  let locale = "en";
  let id = null;
  let batch = false;
  let localeExplicit = false;
  let outDir = path.join(root, "data");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--locale" && argv[i + 1]) {
      locale = argv[++i];
      localeExplicit = true;
    } else if (argv[i] === "--id" && argv[i + 1]) id = argv[++i];
    else if (argv[i] === "--batch") batch = true;
    else if (argv[i] === "--out-dir" && argv[i + 1]) outDir = path.resolve(argv[++i]);
  }
  return { locale, id, batch, outDir, localeExplicit };
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
  const hangUp =
    locale === "es"
      ? `After the agent thanks you for confirming your name (e.g. "gracias por confirmar"), you may say "de nada" once or stay silent—do not ask whether they need anything else, do not ask if they are still on the line, do not simulate hanging up or prolonged silence in parentheses, and do not start a new topic. The name task is finished.`
      : `After the agent thanks you for confirming your name, you may say "you're welcome" briefly or stay silent—do not ask for anything else or simulate call mechanics. The name task is finished.`;
  return [
    `You are the human caller (not the agent).`,
    `Your real full name is exactly: "${fullName}".`,
    lang,
    `Give your name when asked. If the agent asks you to spell it, spell it letter by letter accurately.`,
    `If the agent asks whether the spelling is correct, answer with an explicit yes or correct only if it matches your real name.`,
    hangUp,
    `Do not say you are an AI.`,
  ].join("\n");
}

function heardAgentPrompt(spokenText) {
  return `The agent just said (this is what you heard on the phone):\n"${spokenText}"\n\nWhat do you say next?`;
}

// Yes/no on spelling only (not spell-requests like deletrear).
function assistantAskedYesNoConfirmSpelling(spoken) {
  return (
    /is (that|it) (correct|right)\??/i.test(spoken) ||
    /is it\s+[A-Z]/i.test(spoken) ||
    /let me (just )?confirm/i.test(spoken) ||
    /confirm (the )?spelling/i.test(spoken) ||
    /did I get (that|it) (all )?right\??/i.test(spoken) ||
    /sound (alright|right|good)\??/i.test(spoken) ||
    /does that (look|sound) (right|correct)\??/i.test(spoken) ||
    /(d[eé]jame|d[eé]jeme)\s+confirmar/i.test(spoken) ||
    /perm[ií]tame\s+confirmar/i.test(spoken) ||
    /¿?\s*es\s+correcto/i.test(spoken) ||
    /¿?\s*está\s+correcto/i.test(spoken) ||
    /confirmar\s+la\s+escritura/i.test(spoken) ||
    /está\s+bien\s+escrito/i.test(spoken) ||
    /bien\s+escrito\s+así/i.test(spoken) ||
    /¿?\s*está\s+bien\s+así/i.test(spoken) ||
    /correcto\s+as[ií]/i.test(spoken) ||
    /as[ií]\s+est(á|a)\s+(bien|correcto)/i.test(spoken) ||
    /todo\s+correcto/i.test(spoken) ||
    /va\s+bien\s+as[ií]/i.test(spoken) ||
    /\b(lo\s+he\s+dicho|dicho\s+bien|tal\s+cual)\b/i.test(spoken) ||
    /\bverdad\s*\?/i.test(spoken)
  );
}

function customerSaysExplicitYes(text) {
  const t = text.trim();
  if (/^\s*no[,.]?\s+(el|la|los|el\s+apellido|el\s+nombre|pero|espera|solo)\b/i.test(t)) return false;
  if (/^\s*(yes|yeah|yep|yup|correct|that'?s right|that'?s correct|exactly)\b/i.test(t)) return true;
  if (/^\s*s[ií](?:$|[\s,.;:!?]|est(á|a)\s|es\s)/i.test(t)) return true;
  if (/^\s*(correcto|exacto)\b/i.test(t)) return true;
  if (/\b(es|está)\s+correcto\b/i.test(t)) {
    if (/\bno\s+(es|está)\s+correcto\b/i.test(t)) return false;
    return true;
  }
  return false;
}

// Terminal thanks after confirm (not thanks + another question or small talk).
function assistantSaysThanksAck(spoken) {
  const t = spoken
    .replace(/\s+/g, " ")
    .replace(/[—–]/g, ",")
    .trim();
  if (!t) return false;
  if (/¿/.test(t) || /\?/.test(t)) return false;
  if (t.length > 220) return false;
  if (
    /\b(hay\s+algo\s+m[aá]s|algo\s+m[aá]s\s+en\s+lo\s+que|sigues\s+en\s+(la\s+)?l[ií]nea|no\s+escuch[eé]|cort[óo]\s+el\s+audio|empez(ar|emos)\s+de\s+nuevo|me\s+dices\s+por\s+favor\s+tu\s+nombre|me\s+recuerdas|me\s+repites)\b/i.test(
      t
    )
  ) {
    return false;
  }
  if (/\b(qu[eé]\s+tengas|que\s+tenga|buen\s+d[ií]a|hasta\s+luego|encantad[oa])\b/i.test(t)) {
    if (!/\b(por\s+confirm|for\s+confirm)/i.test(t)) return false;
  }

  if (/^perfecto\s*,?\s*(muchas\s+)?gracias\s+por\s+confirm/i.test(t)) return true;
  if (/^(genial|excelente)\s*,?\s*gracias(\s+por\s+confirm)?/i.test(t)) return true;
  if (/^muy\s+bien\s*,?\s*gracias(\s+por\s+confirm)?/i.test(t)) return true;
  if (/^(thanks|thank you)\b/i.test(t) && /\bconfirm/i.test(t)) return true;
  if (/\bgracias\s+por\s+confirm(arlo|ar|ado)?\b/i.test(t)) return true;
  if (/^(muchas\s+)?gracias\s*[.!]?$/i.test(t)) return true;
  return false;
}

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

  let pendingYesNoConfirmSpelling = false;

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
      pendingYesNoConfirmSpelling && customerSaysExplicitYes(customerText);

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
      logErr("=== Stopped: confirm → yes → thanks. ===\n");
      return;
    }

    pendingYesNoConfirmSpelling = assistantAskedYesNoConfirmSpelling(spoken);

    customerMessages.push({ role: "user", content: heardAgentPrompt(spoken) });
  }

  logErr(`=== Stopped: MAX_TURNS (${MAX_TURNS}) without confirm → yes → thanks. ===\n`);
}

async function main() {
  const { locale, id: idFromCli, batch, outDir, localeExplicit } = parseCommandLine(process.argv.slice(2));

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

    if (localeExplicit) {
      if (locale !== "es" && locale !== "en") {
        console.error('With --batch, --locale must be "es" or "en".');
        process.exit(1);
      }
      await runLocaleBatch(locale);
    } else {
      await runLocaleBatch("es");
      await runLocaleBatch("en");
    }
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
