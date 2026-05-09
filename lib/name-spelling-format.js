// Spelled-name confirmation formatters for the TTS name-collection flow.
//
// Six formats — two for English, four for Spanish.
//
// English:
//   en-1  hyphen-separated UPPERCASE letters; comma between first/last.
//         "James Smith" -> "Let me confirm: J-A-M-E-S, S-M-I-T-H. Is that correct?"
//   en-2  comma-separated UPPERCASE letters across the whole name.
//         "James Smith" -> "Let me confirm: J, A, M, E, S, S, M, I, T, H. Is that correct?"
//
// Spanish:
//   es-1  hyphen-separated UPPERCASE Latin letters; comma between parts;
//         diacritics stripped (Jose, Garcia, Munoz).
//         "Jose Garcia" -> "Muy bien, entonces, solo para confirmar: J-O-S-E, G-A-R-C-I-A. ¿Es correcto?"
//   es-2  hyphen-separated Spanish letter names (jota, ese, ene, ...);
//         accented vowels become "<vowel> con acento"; hyphens between parts too.
//         -> "Muy bien, entonces, solo para confirmar: jota-o-ese-e con acento-ge-a-erre-ce-i con acento-a. ¿Es correcto?"
//   es-3  comma-separated UPPERCASE Latin letters; diacritics stripped.
//         -> "Muy bien, entonces, solo para confirmar: J, O, S, E, G, A, R, C, I, A. ¿Es correcto?"
//   es-4  comma-separated Spanish letter names; X con acento for accents.
//         -> "Muy bien, entonces, solo para confirmar: jota, o, ese, e con acento, ge, a, erre, ce, i con acento, a. ¿Es correcto?"

const SPANISH_LETTER_NAMES = {
  a: "a",
  b: "be",
  c: "ce",
  d: "de",
  e: "e",
  f: "efe",
  g: "ge",
  h: "hache",
  i: "i",
  j: "jota",
  k: "ka",
  l: "ele",
  m: "eme",
  n: "ene",
  "\u00f1": "e\u00f1e",
  o: "o",
  p: "pe",
  q: "cu",
  r: "erre",
  s: "ese",
  t: "te",
  u: "u",
  v: "uve",
  w: "doble uve",
  x: "equis",
  y: "ye",
  z: "zeta",
};

const ACCENT_BASE = {
  "\u00e1": "a",
  "\u00e9": "e",
  "\u00ed": "i",
  "\u00f3": "o",
  "\u00fa": "u",
  "\u00fc": "u",
  "\u00f1": "n",
};

const EN_LEAD_IN = "Let me confirm: ";
const EN_OUTRO = ". Is that correct?";
const ES_LEAD_IN = "Muy bien, entonces, solo para confirmar: ";
const ES_OUTRO = ". \u00bfEs correcto?";

/**
 * @typedef {Object} SpellingFormat
 * @property {"en"|"es"} locale
 * @property {"latin"|"spanish-names"} style
 * @property {string} letterSep
 * @property {string} partSep
 * @property {boolean} stripAccents
 * @property {string} leadIn
 * @property {string} outro
 * @property {string} description
 */

/** @type {Record<string, SpellingFormat>} */
export const FORMATS = {
  "en-1": {
    locale: "en",
    style: "latin",
    letterSep: "-",
    partSep: ", ",
    stripAccents: true,
    leadIn: EN_LEAD_IN,
    outro: EN_OUTRO,
    description: "Hyphen-separated letters; comma between first and last.",
  },
  "en-2": {
    locale: "en",
    style: "latin",
    letterSep: ", ",
    partSep: ", ",
    stripAccents: true,
    leadIn: EN_LEAD_IN,
    outro: EN_OUTRO,
    description: "Comma-separated letters across the whole name.",
  },
  "es-1": {
    locale: "es",
    style: "latin",
    letterSep: "-",
    partSep: ", ",
    stripAccents: true,
    leadIn: ES_LEAD_IN,
    outro: ES_OUTRO,
    description: "Hyphen-separated Latin letters; comma between parts; diacritics stripped.",
  },
  "es-2": {
    locale: "es",
    style: "spanish-names",
    letterSep: "-",
    partSep: "-",
    stripAccents: false,
    leadIn: ES_LEAD_IN,
    outro: ES_OUTRO,
    description: "Hyphen-separated Spanish letter names; X con acento for accents.",
  },
  "es-3": {
    locale: "es",
    style: "latin",
    letterSep: ", ",
    partSep: ", ",
    stripAccents: true,
    leadIn: ES_LEAD_IN,
    outro: ES_OUTRO,
    description: "Comma-separated Latin letters; diacritics stripped.",
  },
  "es-4": {
    locale: "es",
    style: "spanish-names",
    letterSep: ", ",
    partSep: ", ",
    stripAccents: false,
    leadIn: ES_LEAD_IN,
    outro: ES_OUTRO,
    description: "Comma-separated Spanish letter names; X con acento for accents.",
  },
};

function splitParts(fullName) {
  return String(fullName ?? "")
    .trim()
    .split(/[\s\-]+/u)
    .filter(Boolean);
}

function spellPartLatin(part, letterSep, stripAccents) {
  const tokens = [];
  for (const ch of part) {
    let c = ch;
    if (stripAccents) {
      const lower = c.toLowerCase();
      if (lower in ACCENT_BASE) {
        const base = ACCENT_BASE[lower];
        c = c === lower ? base : base.toUpperCase();
      }
    }
    if (/^[A-Za-z]$/.test(c)) tokens.push(c.toUpperCase());
  }
  return tokens.join(letterSep);
}

function spellPartSpanishNames(part, letterSep) {
  const tokens = [];
  const chars = [...part.toLowerCase()];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "r" && chars[i + 1] === "r") {
      tokens.push("erre doble");
      i++;
      continue;
    }
    if (ch !== "\u00f1" && ch in ACCENT_BASE) {
      tokens.push(`${ACCENT_BASE[ch]} con acento`);
      continue;
    }
    if (ch in SPANISH_LETTER_NAMES) tokens.push(SPANISH_LETTER_NAMES[ch]);
  }
  return tokens.join(letterSep);
}

function spellLetters(fmt, fullName) {
  const parts = splitParts(fullName);
  if (parts.length === 0) return "";
  const spell = fmt.style === "spanish-names"
    ? (p) => spellPartSpanishNames(p, fmt.letterSep)
    : (p) => spellPartLatin(p, fmt.letterSep, fmt.stripAccents);
  return parts.map(spell).filter(Boolean).join(fmt.partSep);
}

/**
 * Build the complete confirmation sentence (lead-in + spelled letters + outro).
 * @param {string} fullName
 * @param {keyof typeof FORMATS} formatId
 * @returns {string}
 */
export function spellName(fullName, formatId) {
  const fmt = FORMATS[formatId];
  if (!fmt) throw new Error(`Unknown spelling format: ${formatId}`);
  return `${fmt.leadIn}${spellLetters(fmt, fullName)}${fmt.outro}`;
}

/**
 * @param {keyof typeof FORMATS} formatId
 * @returns {"en"|"es"}
 */
export function localeForFormat(formatId) {
  const fmt = FORMATS[formatId];
  if (!fmt) throw new Error(`Unknown spelling format: ${formatId}`);
  return fmt.locale;
}
