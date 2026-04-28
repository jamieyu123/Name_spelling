/** AI caller + assistant → confirmation (stdout). OPENAI_API_KEY; CARTISIA_API_KEY for TTS. Default WAV: out/cartesia-tts/{en|es}/ */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { getCartesiaApiKey, synthesizeCartesiaBytes } from "../lib/cartesia-tts.js";
import { loadNameEntries, pickNameEntry, runOneSimulation, stripSsmlBreaks } from "../lib/name-simulation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
/** Default Cartesia TTS output: `out/cartesia-tts/{en|es}/` */
const cartesiaTtsOutDir = (locale) => path.join(root, "out", "cartesia-tts", locale);

const CARTESIA_REST = {
  model_id: "sonic-3",
  voice: { mode: "id", id: "86e30c1d-714b-4074-a1f2-1cb6b552fb49" },
  output_format: { container: "wav", encoding: "pcm_f32le", sample_rate: 44100 },
  generation_config: { speed: 1, volume: 1.2, emotion: "neutral" },
  cartesiaVersion: "2025-04-16",
};

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
    await writeTtsWavForLocale(openai, "en", cartesiaTtsOutDir("en"));
    await writeTtsWavForLocale(openai, "es", cartesiaTtsOutDir("es"));
    return;
  }
  if (writeTtsBatch) {
    await writeTtsWavForLocale(openai, locale, ttsOutDir ?? cartesiaTtsOutDir(locale));
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
