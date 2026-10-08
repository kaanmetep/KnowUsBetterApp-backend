/**
 * Profanity masking for short user text (typed answers, player names), backed
 * by terlik.js. The answer's language is unknown, so the Turkish, English and
 * Spanish dictionaries all run and their matches are merged. A flagged span
 * keeps its first character and the rest becomes "*".
 */
import { Terlik } from "terlik.js";

type Match = ReturnType<Terlik["getMatches"]>[number];

const FILTERS = ["tr", "en", "es"].map((language) => new Terlik({ language }));

/**
 * The Turkish dictionary folds ı → i and ö → o, which flags everyday words:
 * "sık sık", "sıkıldım", English "I got it" / "I am". Drop those matches by
 * looking at how the word was actually spelled.
 */
function isFalsePositive(match: Match): boolean {
  const word = match.word.toLocaleLowerCase("tr");
  switch (match.root) {
    case "sik":
      return word.startsWith("sık");
    case "göt":
      return !word.includes("ö");
    case "am":
      return word === "am";
    default:
      return false;
  }
}

function profaneRanges(text: string): Array<[number, number]> {
  const ranges = FILTERS.flatMap((filter) => filter.getMatches(text))
    .filter((match) => !isFalsePositive(match))
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
