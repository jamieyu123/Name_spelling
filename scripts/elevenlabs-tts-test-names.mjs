/**
 * Name simulation + ElevenLabs TTS. JSON → out/elevenlabs/text/; batch MP3 → out/elevenlabs/tts/{en|es}/.
 * EN 10+10 common/uncommon, ES full (--en-head-each / --limit apply to batch TTS and to JSON+TTS). OPENAI_API_KEY; ELEVENLABS_API_KEY.
 *
 * Commands:
 *   --write-confirmation-json [--write-tts-batch|--write-tts-all] [--locale en|es] [--en-head-each N] [--limit N]
 * node scripts/elevenlabs-tts-test-names.mjs --write-confirmation-json --write-tts-batch
 *   --locale en --id common-1 --tts-out path.mp3
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { getElevenLabsApiKey, synthesizeElevenLabsBytes } from "../lib/elevenlabs-tts.js";
import { loadNameEntries, pickNameEntry, runOneSimulation, stripSsmlBreaks } from "../lib/name-simulation.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const elevenlabsOut = path.join(root, "out", "elevenlabs");
const elevenlabsTextDir = path.join(elevenlabsOut, "text");
const elevenlabsTtsMp3Dir = (locale) => path.join(elevenlabsOut, "tts", locale);
const ELEVENLABS_EN_HEAD_EACH = 10;

const silentSinks = { log: () => { }, logErr: () => { } };

function enHeadLoadOpts(locale) {
  return locale === "en" ? { enHeadEach: ELEVENLABS_EN_HEAD_EACH } : {};
}

/** Same entry selection as batch MP3 (--en-head-each for en only; --limit caps list). */
function loadEntriesForBatch(locale, batchOpts = {}) {
  const limit = batchOpts.limit ?? null;
  const enHeadEach = locale === "en" ? (batchOpts.enHeadEach ?? ELEVENLABS_EN_HEAD_EACH) : null;
  const loadOpts = enHeadEach != null ? { enHeadEach } : {};
  let entries = loadNameEntries(locale, loadOpts);
  if (limit != null) entries = entries.slice(0, limit);
  return entries;
}

async function elevenLabsMp3Bytes(spoken, locale) {
  return synthesizeElevenLabsBytes(stripSsmlBreaks(spoken), {
    languageCode: locale === "es" ? "es" : "en",
  });
}

async function writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOutFile, loadOpts = {}, mp3Dir = null, limit = null) {
  let entries = loadNameEntries(locale, loadOpts);
  if (limit != null) entries = entries.slice(0, limit);
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
    if (mp3Dir && spoken?.trim()) {
      fs.mkdirSync(mp3Dir, { recursive: true });
      fs.writeFileSync(path.join(mp3Dir, `${entry.id}.mp3`), await elevenLabsMp3Bytes(spoken, locale));
    }
    payload.entries.push({
      id: entry.id,
      fullName: entry.fullName,
      confirmationSentences: spoken?.trim() ? [spoken] : [],
    });
  }

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.error(
    mp3Dir
      ? `Wrote ${payload.entries.length} entries to ${outFile}; MP3(s) under ${mp3Dir}`
      : `Wrote ${payload.entries.length} entries to ${outFile}`,
  );
}

async function writeTtsMp3ForLocale(openai, locale, dir, batchOpts = {}) {
  const entries = loadEntriesForBatch(locale, batchOpts);
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
    fs.writeFileSync(path.join(dir, `${entry.id}.mp3`), await elevenLabsMp3Bytes(spoken, locale));
    wrote += 1;
  }
  console.error(`Wrote ${wrote} MP3 file(s) under ${dir}`);
}

function parseCommandLine(argv) {
  let locale = "en";
  let localeExplicit = false;
  let id = null;
  let writeConfirmationJson = false;
  let writeTtsBatch = false;
  let writeTtsAllLocales = false;
  let outDir = elevenlabsTextDir;
  let confirmationOut = null;
  let ttsOut = null;
  let ttsOutDir = null;
  let enHeadEach = null;
  let limit = null;
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
    else if (argv[i] === "--en-head-each" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      enHeadEach = Number.isFinite(n) ? n : null;
    } else if (argv[i] === "--limit" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      limit = Number.isFinite(n) ? Math.max(0, n) : null;
    }
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
    enHeadEach,
    limit,
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
    enHeadEach,
    limit,
  } = parseCommandLine(process.argv.slice(2));

  if (!process.env.OPENAI_API_KEY) bail("Missing OPENAI_API_KEY in environment.");
  const anyTts = ttsOut || writeTtsBatch || writeTtsAllLocales;
  const jsonAndTtsBatch = writeConfirmationJson && (writeTtsBatch || writeTtsAllLocales);
  if (writeConfirmationJson && anyTts && !jsonAndTtsBatch) {
    bail("Cannot combine --write-confirmation-json with --tts-out (use --write-tts-batch|--write-tts-all with JSON, or --tts-out alone; text → stdout).");
  }
  if (ttsOut && (writeTtsBatch || writeTtsAllLocales)) bail("Use either --tts-out or batch TTS flags, not both.");
  if (writeTtsBatch && writeTtsAllLocales) bail("Use either --write-tts-batch or --write-tts-all, not both.");
  if ((anyTts || jsonAndTtsBatch) && !getElevenLabsApiKey()) bail("Missing ELEVENLABS_API_KEY for TTS.");
  if (enHeadEach != null && !writeTtsBatch && !writeTtsAllLocales) {
    bail("--en-head-each is only used with --write-tts-batch or --write-tts-all.");
  }
  if (enHeadEach != null && locale === "es" && writeTtsBatch && !writeTtsAllLocales) {
    bail("With --en-head-each, use --locale en for --write-tts-batch, or use --write-tts-all.");
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const batchOpts = { enHeadEach, limit };

  if (writeConfirmationJson) {
    if (!localeExplicit && confirmationOut) {
      bail("With --write-confirmation-json, use --locale when using --confirmation-out (or omit --confirmation-out for default filenames).");
    }
    if (jsonAndTtsBatch) {
      const enLoad = { enHeadEach: batchOpts.enHeadEach ?? ELEVENLABS_EN_HEAD_EACH };
      if (writeTtsAllLocales || !localeExplicit) {
        await writeConfirmationJsonForLocale(openai, outDir, "en", null, enLoad, elevenlabsTtsMp3Dir("en"), batchOpts.limit);
        await writeConfirmationJsonForLocale(openai, outDir, "es", null, {}, elevenlabsTtsMp3Dir("es"), batchOpts.limit);
      } else {
        const loadOpts = locale === "en" ? enLoad : {};
        await writeConfirmationJsonForLocale(openai, outDir, locale, confirmationOut, loadOpts, ttsOutDir ?? elevenlabsTtsMp3Dir(locale), batchOpts.limit);
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
    await writeTtsMp3ForLocale(openai, "en", elevenlabsTtsMp3Dir("en"), batchOpts);
    await writeTtsMp3ForLocale(openai, "es", elevenlabsTtsMp3Dir("es"), batchOpts);
    return;
  }
  if (writeTtsBatch) {
    await writeTtsMp3ForLocale(openai, locale, ttsOutDir ?? elevenlabsTtsMp3Dir(locale), batchOpts);
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
    fs.writeFileSync(outPath, await elevenLabsMp3Bytes(spoken, locale));
    console.error(`Wrote TTS → ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
