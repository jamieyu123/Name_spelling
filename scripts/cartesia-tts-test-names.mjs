/**
 * Name simulation + Cartesia TTS. JSON → out/cartesia/text/; batch WAV → out/cartesia/tts/{en|es}/.
 * EN 10+10 common/uncommon, ES full (JSON dual-run + batch TTS). OPENAI_API_KEY; CARTISIA_API_KEY for TTS.
 *
 * Commands:
 *   --write-confirmation-json [--write-tts-batch|--write-tts-all] [--locale en|es]
 *   --locale en --id common-1 --tts-out path.wav
 *   node scripts/cartesia-tts-test-names.mjs --write-confirmation-json --write-tts-batch
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { cartesiaVoiceForLocale, getCartesiaApiKey, synthesizeCartesiaBytes } from "../lib/cartesia-tts.js";
import { loadNameEntries, pickNameEntry, runOneSimulation, stripSsmlBreaks } from "../lib/name-simulation.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cartesiaOut = path.join(root, "out", "cartesia");
const cartesiaTextDir = path.join(cartesiaOut, "text");
const cartesiaTtsWavDir = (locale) => path.join(cartesiaOut, "tts", locale);
const CARTESIA_EN_HEAD_EACH = 10;

const CARTESIA_REST = {
  model_id: process.env.CARTESIA_TTS_MODEL ?? "sonic-3-latest",
  output_format: { container: "wav", encoding: "pcm_f32le", sample_rate: 44100 },
  generation_config: { speed: 1, volume: 1.2, emotion: "neutral" },
  cartesiaVersion: "2025-04-16",
};

const silentSinks = { log: () => { }, logErr: () => { } };

async function cartesiaWavBytes(spoken, locale) {
  return synthesizeCartesiaBytes(stripSsmlBreaks(spoken), {
    modelId: CARTESIA_REST.model_id,
    voice: cartesiaVoiceForLocale(locale),
    language: locale === "es" ? "es" : "en",
    apiVersion: CARTESIA_REST.cartesiaVersion,
    outputFormat: CARTESIA_REST.output_format,
    generationConfig: CARTESIA_REST.generation_config,
  });
}

async function writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOutFile, loadOpts = {}, wavDir = null) {
  const entries = loadNameEntries(locale, loadOpts);
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
    process.stderr.write(`[${i + 1}/${entries.length}] ${entry.id} "${entry.fullName}" …\n`);
    const spoken = await runOneSimulation(openai, { locale, id: entry.id, fullName: entry.fullName }, silentSinks);
    if (wavDir && spoken?.trim()) {
      fs.mkdirSync(wavDir, { recursive: true });
      fs.writeFileSync(path.join(wavDir, `${entry.id}.wav`), await cartesiaWavBytes(spoken, locale));
    }
    payload.entries.push({
      id: entry.id,
      fullName: entry.fullName,
      confirmationSentences: spoken?.trim() ? [spoken] : [],
    });
  }

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.error(
    wavDir
      ? `Wrote ${payload.entries.length} entries to ${outFile}; WAV(s) under ${wavDir}`
      : `Wrote ${payload.entries.length} entries to ${outFile}`,
  );
}

function enHeadLoadOpts(locale) {
  return locale === "en" ? { enHeadEach: CARTESIA_EN_HEAD_EACH } : {};
}

async function writeTtsWavForLocale(openai, locale, dir, loadOpts = enHeadLoadOpts(locale)) {
  const entries = loadNameEntries(locale, loadOpts);
  fs.mkdirSync(dir, { recursive: true });
  let wrote = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    process.stderr.write(`[${i + 1}/${entries.length}] ${locale} ${entry.id} "${entry.fullName}" …\n`);
    const spoken = await runOneSimulation(openai, { locale, id: entry.id, fullName: entry.fullName }, silentSinks);
    if (!spoken?.trim()) {
      console.error(`  skip (empty confirmation): ${entry.id}`);
      continue;
    }
    fs.writeFileSync(path.join(dir, `${entry.id}.wav`), await cartesiaWavBytes(spoken, locale));
    wrote += 1;
  }
  console.error(`Wrote ${wrote} WAV file(s) under ${dir}`);
}

function parseCommandLine(argv) {
  let locale = "en";
  let localeExplicit = false;
  let id = null;
  let writeConfirmationJson = false;
  let writeTtsBatch = false;
  let writeTtsAllLocales = false;
  let outDir = cartesiaTextDir;
  let confirmationOut = null;
  let ttsOut = null;
  let ttsOutDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--locale" && argv[i + 1]) {
      localeExplicit = true;
      locale = argv[++i];
    } else if (argv[i] === "--id" && argv[i + 1]) id = argv[++i];
    else if (argv[i] === "--write-confirmation-json") writeConfirmationJson = true;
    else if (argv[i] === "--write-tts-batch") writeTtsBatch = true;
    else if (argv[i] === "--write-tts-all") writeTtsAllLocales = true;
    else if (argv[i] === "--out-dir" && argv[i + 1]) outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--confirmation-out" && argv[i + 1]) confirmationOut = argv[++i];
    else if (argv[i] === "--tts-out" && argv[i + 1]) ttsOut = argv[++i];
    else if (argv[i] === "--tts-out-dir" && argv[i + 1]) ttsOutDir = path.resolve(argv[++i]);
  }
  return {
    locale,
    localeExplicit,
    id,
    outDir,
    writeConfirmationJson,
    writeTtsBatch,
    writeTtsAllLocales,
    confirmationOut,
    ttsOut,
    ttsOutDir,
  };
}

function bail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const {
    locale,
    localeExplicit,
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
  const jsonAndTtsBatch = writeConfirmationJson && (writeTtsBatch || writeTtsAllLocales);
  if (writeConfirmationJson && anyTts && !jsonAndTtsBatch) {
    bail("Cannot combine --write-confirmation-json with --tts-out (use --write-tts-batch|--write-tts-all with JSON, or --tts-out alone; text → stdout).");
  }
  if (ttsOut && (writeTtsBatch || writeTtsAllLocales)) bail("Use either --tts-out or batch TTS flags, not both.");
  if (writeTtsBatch && writeTtsAllLocales) bail("Use either --write-tts-batch or --write-tts-all, not both.");
  if ((anyTts || jsonAndTtsBatch) && !getCartesiaApiKey()) bail("Missing CARTISIA_API_KEY for TTS.");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (writeConfirmationJson) {
    if (!localeExplicit && confirmationOut) {
      bail("With --write-confirmation-json, use --locale when using --confirmation-out (or omit --confirmation-out for default filenames).");
    }
    if (jsonAndTtsBatch) {
      if (writeTtsAllLocales || !localeExplicit) {
        await writeConfirmationJsonForLocale(openai, outDir, "en", null, enHeadLoadOpts("en"), cartesiaTtsWavDir("en"));
        await writeConfirmationJsonForLocale(openai, outDir, "es", null, enHeadLoadOpts("es"), cartesiaTtsWavDir("es"));
      } else {
        await writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOut, enHeadLoadOpts(locale), ttsOutDir ?? cartesiaTtsWavDir(locale));
      }
      return;
    }
    if (localeExplicit) {
      await writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOut, enHeadLoadOpts(locale));
    } else {
      await writeConfirmationJsonForLocale(openai, outDir, "en", null, enHeadLoadOpts("en"));
      await writeConfirmationJsonForLocale(openai, outDir, "es", null, enHeadLoadOpts("es"));
    }
    return;
  }
  if (writeTtsAllLocales) {
    await writeTtsWavForLocale(openai, "en", cartesiaTtsWavDir("en"));
    await writeTtsWavForLocale(openai, "es", cartesiaTtsWavDir("es"));
    return;
  }
  if (writeTtsBatch) {
    await writeTtsWavForLocale(openai, locale, ttsOutDir ?? cartesiaTtsWavDir(locale));
    return;
  }

  const { id, fullName } = pickNameEntry(loadNameEntries(locale), idFromCli);
  const spoken = await runOneSimulation(openai, { locale, id, fullName }, {
    log: console.log.bind(console),
    logErr: console.error.bind(console),
  });

  if (ttsOut && spoken?.trim()) {
    const outPath = path.resolve(ttsOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, await cartesiaWavBytes(spoken, locale));
    console.error(`Wrote TTS → ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
