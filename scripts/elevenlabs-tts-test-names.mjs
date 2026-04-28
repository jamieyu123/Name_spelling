/**
 * ElevenLabs MP3: same name → spell → confirmation simulation as scripts/simulate-loop.mjs, different TTS backend.
 *
 * OPENAI_API_KEY, ELEVENLABS_API_KEY. Default TTS output: out/elevenlabs-tts/{en|es}/<id>.mp3
 *
 * Examples:
 *   node scripts/elevenlabs-tts-test-names.mjs
 *   node scripts/elevenlabs-tts-test-names.mjs --locale en --id common-1
 *   node scripts/elevenlabs-tts-test-names.mjs --write-tts-batch
 *   node scripts/elevenlabs-tts-test-names.mjs --write-tts-all
 *   node scripts/elevenlabs-tts-test-names.mjs --write-tts-all --en-head-each 10
 *   node scripts/elevenlabs-tts-test-names.mjs --write-tts-batch --locale en --en-head-each 10 --limit 3
 *   node scripts/elevenlabs-tts-test-names.mjs --tts-out out/elevenlabs-tts/en/sample.mp3
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { getElevenLabsApiKey, synthesizeElevenLabsBytes } from "../lib/elevenlabs-tts.js";
import { loadNameEntries, pickNameEntry, runOneSimulation, stripSsmlBreaks } from "../lib/name-simulation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

/** Default ElevenLabs TTS output: `out/elevenlabs-tts/{en|es}/` */
const elevenlabsTtsOutDir = (locale) => path.join(root, "out", "elevenlabs-tts", locale);

async function elevenLabsMp3Bytes(spoken, locale) {
  return synthesizeElevenLabsBytes(stripSsmlBreaks(spoken), {
    languageCode: locale === "es" ? "es" : "en",
  });
}

/** Batch: run simulation per name, write `${id}.mp3` (confirmation audio). */
async function writeTtsMp3ForLocale(openai, locale, dir, options = {}) {
  const { enHeadEach = null, limit = null } = options;
  const loadOpts = enHeadEach != null && locale === "en" ? { enHeadEach } : {};
  let entries = loadNameEntries(locale, loadOpts);
  if (limit != null) entries = entries.slice(0, limit);
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
    fs.writeFileSync(path.join(dir, `${entry.id}.mp3`), await elevenLabsMp3Bytes(spoken, locale));
    wrote += 1;
  }
  console.error(`Wrote ${wrote} MP3 file(s) under ${dir}`);
}

function parseCommandLine(argv) {
  let locale = "en";
  let id = null;
  let writeTtsBatch = false;
  let writeTtsAllLocales = false;
  let ttsOut = null;
  let ttsOutDir = null;
  let enHeadEach = null;
  let limit = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--locale" && argv[i + 1]) locale = argv[++i];
    else if (argv[i] === "--id" && argv[i + 1]) id = argv[++i];
    else if (argv[i] === "--write-tts-batch") writeTtsBatch = true;
    else if (argv[i] === "--write-tts-all") writeTtsAllLocales = true;
    else if (argv[i] === "--tts-out" && argv[i + 1]) ttsOut = argv[++i];
    else if (argv[i] === "--tts-out-dir" && argv[i + 1]) ttsOutDir = path.resolve(argv[++i]);
    else if (argv[i] === "--en-head-each" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      enHeadEach = Number.isFinite(n) ? n : null;
    } else if (argv[i] === "--limit" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      limit = Number.isFinite(n) ? Math.max(0, n) : null;
    }
  }
  if (enHeadEach != null && !writeTtsBatch && !writeTtsAllLocales) {
    throw new Error("--en-head-each is only used with --write-tts-batch or --write-tts-all.");
  }
  if (enHeadEach != null && locale === "es" && writeTtsBatch && !writeTtsAllLocales) {
    throw new Error("With --en-head-each, use --locale en for --write-tts-batch, or use --write-tts-all.");
  }
  return { locale, id, writeTtsBatch, writeTtsAllLocales, ttsOut, ttsOutDir, enHeadEach, limit };
}

function bail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const { locale, id: idFromCli, writeTtsBatch, writeTtsAllLocales, ttsOut, ttsOutDir, enHeadEach, limit } = parseCommandLine(
    process.argv.slice(2),
  );

  if (!process.env.OPENAI_API_KEY) bail("Missing OPENAI_API_KEY in environment.");
  const anyTts = ttsOut || writeTtsBatch || writeTtsAllLocales;
  if (ttsOut && (writeTtsBatch || writeTtsAllLocales)) bail("Use either --tts-out or batch TTS flags, not both.");
  if (writeTtsBatch && writeTtsAllLocales) bail("Use either --write-tts-batch or --write-tts-all, not both.");
  if (anyTts && !getElevenLabsApiKey()) bail("Missing ELEVENLABS_API_KEY for TTS.");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const batchOpts = { enHeadEach, limit };

  if (writeTtsAllLocales) {
    await writeTtsMp3ForLocale(openai, "en", elevenlabsTtsOutDir("en"), batchOpts);
    await writeTtsMp3ForLocale(openai, "es", elevenlabsTtsOutDir("es"), { limit: batchOpts.limit });
    return;
  }
  if (writeTtsBatch) {
    await writeTtsMp3ForLocale(openai, locale, ttsOutDir ?? elevenlabsTtsOutDir(locale), batchOpts);
    return;
  }

  const { id, fullName } = pickNameEntry(loadNameEntries(locale), idFromCli);
  const spoken = await runOneSimulation(openai, { locale, id, fullName }, {
    log: console.log.bind(console),
    logErr: console.error.bind(console),
  });

  if (ttsOut && spoken?.trim()) {
    const outPath = path.resolve(ttsOut);
    const ttsD = path.dirname(outPath);
    if (ttsD) fs.mkdirSync(ttsD, { recursive: true });
    fs.writeFileSync(outPath, await elevenLabsMp3Bytes(spoken, locale));
    console.error(`Wrote TTS → ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
