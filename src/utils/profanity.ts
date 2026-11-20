/**
 * Profanity masking for short user text (typed answers, player names), backed
 * by terlik.js. The answer's language is unknown, so the Turkish, English,
 * Spanish, German, Portuguese, Italian and Polish word lists all run and their
 * matches are merged. A flagged span
 * keeps its first character and the rest becomes "*".
 */
import { Terlik } from "terlik.js";

type Match = ReturnType<Terlik["getMatches"]>[number];

// terlik.js has no Portuguese dictionary; these whole words ride on the
// Spanish filter (same accent folding). Everyday words that double as slang
// ("pau", "rola", "pica") are left out.
const PORTUGUESE_WORDS = [
  "porra", "caralho", "merda", "foda", "foder", "fodase", "fodido", "fodida",
  "puta", "puto", "buceta", "boceta", "cu", "cuzao", "viado", "arrombado",
  "arrombada", "cacete", "piroca", "bosta", "desgracado", "desgracada",
  "vagabunda", "otario", "babaca", "punheta", "xoxota", "xereca",
  "fdp", "pqp", "vsf", "tnc", "krl",
];

// terlik.js has no Italian or Polish dictionary either; their whole words ride on
// the English filter. Everyday words that double as slang (it "culo", "sega";
// pl "dupa", "pedał") and it "troia" (also Troy) are left out. Polish words are listed with and without
// diacritics because people type both.
const ITALIAN_WORDS = [
  "cazzo", "cazzi", "vaffanculo", "fanculo", "stronzo", "stronza", "stronzi",
  "merda", "puttana", "puttane", "coglione", "cogliona", "coglioni",
  "minchia", "fottiti", "fottuto", "fottuta", "bastardo", "bastarda",
  "porcodio", "dioporco", "mignotta", "zoccola", "frocio", "ricchione", "pompino",
];
const POLISH_WORDS = [
  "kurwa", "kurwy", "kurwo", "chuj", "chuja", "chuju", "huj", "pierdol",
  "pierdolić", "pierdolic", "pierdolę", "pierdole", "spierdalaj", "wypierdalaj",
  "jebać", "jebac", "jebany", "jebana", "jebane", "pizda", "pizdy", "skurwysyn",
  "skurwiel", "cipa", "kutas", "ciota", "zjeb", "debil",
];

const FILTERS = [
  new Terlik({ language: "tr" }),
  new Terlik({ language: "en", customList: [...ITALIAN_WORDS, ...POLISH_WORDS] }),
  new Terlik({ language: "es", customList: PORTUGUESE_WORDS }),
  new Terlik({ language: "de" }),
];

/**
 * The dictionaries fold letters and tolerate spaces and digits, so they flag
 * everyday words, often in another language: Turkish "sik"/"göt" in "sık sık"
 * or English "I got it", Turkish "am" in Italian "amici", "mal" in German "noch
 * mal" and Spanish/Portuguese "mal", "bok" in Polish "na boku", English "nonce"
 * in Italian "non". Drop those matches by looking at how the word was spelled.
 */
const POLISH_PREPOSITIONS = new Set(["na", "z", "ze", "w", "we", "po", "do", "u", "przy", "o", "od", "obok", "pod", "nad"]);

function isFalsePositive(match: Match, text: string): boolean {
  const word = match.word.toLocaleLowerCase("tr");
  if (/^[\d\s.,]+$/.test(word)) return true; // "56" read as "sg"
  const before = text.slice(0, match.index).trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  switch (match.root) {
    case "sik":
      return word.startsWith("sık");
    case "göt":
      return !word.includes("ö") || word.startsWith("götter");
    case "am":
      // Turkish forms only: amcık/amcuk, amı…, amına/amini, amk.
      return !/^am(c[ıiu]k|ı|[ıi]n[ıia]|k\b|q\b)/.test(word);
    case "mal": // Turkish insult, but German "noch mal", Spanish/Portuguese "mal"
    case "meme": // Turkish "breast", and the internet meme
    case "hell": // German "bright"
    case "dreck": // German "dirt"
    case "dumm": // German "silly", too mild to mask
    case "negro": // Spanish/Portuguese/Italian "black"
    case "schmuck": // German "jewellery"
      return true;
    case "cu": // Portuguese insult, but "Cu" is copper in trivia answers
      return match.word === "Cu";
    case "schwanz": // German "tail" after an article: "im Schwanz", "der Schwanz"
      return ["im", "am", "dem", "den", "der", "einen", "ein", "sein", "seinen", "mit", "langen", "kurzen"].includes(before);
    case "pezevenk":
      return !word.startsWith("pezev");
    case "oç":
      return word.length < 2 || /[\s']/.test(word);
    case "bok":
      return /\s/.test(word) || POLISH_PREPOSITIONS.has(before) || word === "boki" || word.startsWith("boo");
    case "piç":
      return word.includes("ć") || /^pici[aeu]/.test(word) || word.startsWith("picass") || /pic$/.test(word) && word.length > 4;
    case "domuz":
    case "döl":
    case "alık":
      return !/[öışçğü]/.test(word) && !word.startsWith(match.root) || /\s/.test(word);
    case "spic":
      return /^spic(y|k|e)/.test(word);
    case "nonce":
      return word === "non";
    case "dago":
    case "pervert":
      return !word.startsWith(match.root.slice(0, 4));
    case "puta":
      return word === "put";
    case "spast":
      return !word.startsWith("spast");
    default:
      return false;
  }
}

function profaneRanges(text: string): Array<[number, number]> {
  const ranges = FILTERS.flatMap((filter) => filter.getMatches(text))
    .filter((match) => !isFalsePositive(match, text))
    .map((match): [number, number] => [match.index, match.index + match.word.length])
    .sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export function maskProfanity(text: string): string {
  if (!text) return text;
  const ranges = profaneRanges(text);
  if (ranges.length === 0) return text;

  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    const span = Array.from(text.slice(start, end));
    out += text.slice(cursor, start) + span[0] + "*".repeat(Math.max(1, span.length - 1));
    cursor = end;
  }
  return out + text.slice(cursor);
}

export function containsProfanity(text: string): boolean {
  return !!text && profaneRanges(text).length > 0;
}

/** Compiles the dictionaries ahead of time so the first real answer isn't slow. */
export function warmUpProfanityFilter(): void {
  for (const filter of FILTERS) filter.containsProfanity("warmup");
}
