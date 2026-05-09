// Generate spelled-name confirmation sentences (6 formats) for the names in
// data/test-names.sample.json and synthesize them with Deepgram Aura 2.
//
// Outputs:
//   - Text:  out/deepgram/text/name-spellings.json   (single JSON with all sentences)
//   - Audio: out/deepgram/tts/<format-id>/<entry-id>.wav
//
// Usage:
//   node scripts/deepgram-tts-test-names.mjs                       # text + WAVs (default)
//   node scripts/deepgram-tts-test-names.mjs --no-tts              # text only
//   node scripts/deepgram-tts-test-names.mjs --no-text             # WAVs only
//   node scripts/deepgram-tts-test-names.mjs --formats en-1,es-4   # restrict formats
//   node scripts/deepgram-tts-test-names.mjs --ids common-1,es-1   # restrict entries
//   node scripts/deepgram-tts-test-names.mjs --en-voice aura-2-andromeda-en
//   node scripts/deepgram-tts-test-names.mjs --es-voice aura-2-nestor-es
//
// Env: DEEPGRAM_API_KEY required when generating audio.
//      Optional overrides: DEEPGRAM_TTS_MODEL_EN, DEEPGRAM_TTS_MODEL_ES.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  FORMATS,
  localeForFormat,
  spellName,
} from "../lib/name-spelling-format.js";
import {
  deepgramVoiceForLocale,
  getDeepgramApiKey,
  synthesizeDeepgramWavBytes,
} from "../lib/deepgram-tts.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleDataFile = path.join(root, "data", "test-names.sample.json");
const deepgramOut = path.join(root, "out", "deepgram");
const textOutDir = path.join(deepgramOut, "text");
const audioOutDir = path.join(deepgramOut, "tts");
const textOutFile = path.join(textOutDir, "name-spellings.json");

const SAMPLE_RATE = 24000;
const TIMEOUT_MS = 30000;

function relPosix(p) {
  return path.relative(root, p).replace(/\\/g, "/");
}

function bail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseList(arg) {
  return arg.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadSampleEntries() {
  if (!fs.existsSync(sampleDataFile)) {
    bail(`Sample data file not found: ${relPosix(sampleDataFile)}`);
  }
  const raw = JSON.parse(fs.readFileSync(sampleDataFile, "utf8"));
  const groups = [
    ["common", raw.common ?? [], "en"],
    ["uncommon", raw.uncommon ?? [], "en"],
    ["spanish", raw.spanish ?? [], "es"],
  ];
  const entries = [];
  for (const [group, list, defaultLocale] of groups) {
    for (const item of list) {
      if (!item?.id || !item?.fullName) continue;
      entries.push({
        id: item.id,
        fullName: item.fullName,
        group,
        locale: item.locale ?? defaultLocale,
      });
    }
  }
  return entries;
}

function parseCommandLine(argv) {
  let writeTts = true;
  let writeText = true;
  let formats = null;
  let ids = null;
  let enVoice = null;
  let esVoice = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-tts") writeTts = false;
    else if (a === "--no-text") writeText = false;
    else if (a === "--formats" && argv[i + 1]) formats = parseList(argv[++i]);
    else if (a === "--ids" && argv[i + 1]) ids = parseList(argv[++i]);
    else if (a === "--en-voice" && argv[i + 1]) enVoice = argv[++i];
    else if (a === "--es-voice" && argv[i + 1]) esVoice = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/deepgram-tts-test-names.mjs [options]\n\n" +
          "  --no-tts              Skip audio generation (text only).\n" +
          "  --no-text             Skip writing text JSON (audio only).\n" +
          `  --formats <ids>       Comma-separated subset of: ${Object.keys(FORMATS).join(",")}\n` +
          "  --ids <ids>           Comma-separated subset of entry ids (e.g. common-1,es-1).\n" +
          "  --en-voice <model>    Override English Aura 2 voice (default aura-2-thalia-en).\n" +
          "  --es-voice <model>    Override Spanish Aura 2 voice (default aura-2-celeste-es).\n",
      );
      process.exit(0);
    }
  }
  return { writeTts, writeText, formats, ids, enVoice, esVoice };
}

async function main() {
  const opts = parseCommandLine(process.argv.slice(2));

  if (opts.writeTts && !getDeepgramApiKey()) bail("Missing DEEPGRAM_API_KEY in environment.");

  const allFormatIds = Object.keys(FORMATS);
  const requestedFormats = opts.formats?.length
    ? opts.formats.filter((id) => {
        if (!(id in FORMATS)) {
          console.error(`  unknown format id, skipping: ${id}`);
          return false;
        }
        return true;
      })
    : allFormatIds;
  if (requestedFormats.length === 0) bail("No valid format ids selected.");

  const allEntries = loadSampleEntries();
  if (allEntries.length === 0) bail(`No entries found in ${relPosix(sampleDataFile)}.`);
  const entries = opts.ids?.length
    ? allEntries.filter((e) => opts.ids.includes(e.id))
    : allEntries;
  if (entries.length === 0) bail("No entries matched the requested --ids.");

  const enModel = opts.enVoice ?? deepgramVoiceForLocale("en");
  const esModel = opts.esVoice ?? deepgramVoiceForLocale("es");

  const payload = {
    version: 1,
    source: relPosix(sampleDataFile),
    generatedAt: new Date().toISOString(),
    deepgramModels: { en: enModel, es: esModel },
    deepgramAudio: { encoding: "linear16", container: "wav", sampleRate: SAMPLE_RATE },
    formats: Object.fromEntries(
      requestedFormats.map((id) => [
        id,
        { locale: FORMATS[id].locale, description: FORMATS[id].description },
      ]),
    ),
    entries: [],
  };

  let audioCount = 0;
  const audioErrors = [];

  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e];
    const formatsForEntry = requestedFormats.filter((id) => localeForFormat(id) === entry.locale);
    const formattedTexts = {};
    for (const id of formatsForEntry) {
      formattedTexts[id] = spellName(entry.fullName, id);
    }
    payload.entries.push({
      id: entry.id,
      fullName: entry.fullName,
      formats: formattedTexts,
    });

    if (!opts.writeTts) continue;
    const model = entry.locale === "es" ? esModel : enModel;
    for (const id of formatsForEntry) {
      const text = formattedTexts[id];
      const dir = path.join(audioOutDir, id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${entry.id}.wav`);
      process.stderr.write(
        `[${e + 1}/${entries.length}] ${id} ${entry.id} (${model}) "${entry.fullName}" -> ${relPosix(file)}\n`,
      );
      try {
        const bytes = await synthesizeDeepgramWavBytes(text, {
          model,
          sampleRate: SAMPLE_RATE,
          timeoutMs: TIMEOUT_MS,
        });
        fs.writeFileSync(file, bytes);
        audioCount++;
      } catch (err) {
        audioErrors.push({ id: entry.id, format: id, error: err.message });
        process.stderr.write(`  ERROR: ${err.message}\n`);
      }
    }
  }

  if (opts.writeText) {
    fs.mkdirSync(textOutDir, { recursive: true });
    fs.writeFileSync(textOutFile, JSON.stringify(payload, null, 2), "utf8");
    console.error(`Wrote text JSON -> ${relPosix(textOutFile)}`);
  }
  if (opts.writeTts) {
    console.error(
      `Wrote ${audioCount} WAV file(s) under ${relPosix(audioOutDir)}` +
        (audioErrors.length ? `; ${audioErrors.length} error(s)` : ""),
    );
    if (audioErrors.length) {
      for (const e of audioErrors) console.error(`  ${e.format} ${e.id}: ${e.error}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
