/**
 * Second moderation layer for typed answers: OpenAI's free moderation model
 * catches abuse that a word list can't (slurs spelled out in prose, threats,
 * sexual content involving minors, ...). It fails open — if the API is slow,
 * down or not configured, the answer goes through with only the word filter.
 */
import OpenAI from "openai";

const MODERATION_MODEL = "omni-moderation-latest";
const MODERATION_TIMEOUT_MS = 1500;

/**
 * Plain "harassment" is left out and "violence" only counts above a high score:
 * partners teasing each other ("I'd kill you if you ate my fries", ~0.6) is the
 * point of the game, while real threats ("I want to stab him", ~0.95) are not.
 */
const SCORE_THRESHOLDS: Record<string, number> = {
  violence: 0.85,
};

const BLOCKED_CATEGORIES = [
  "hate",
  "hate/threatening",
  "harassment/threatening",
  "sexual",
  "sexual/minors",
  "violence/graphic",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "illicit/violent",
] as const;

let client: OpenAI | null | undefined;

function getClient(): OpenAI | null {
  if (client === undefined) {
    const apiKey = process.env.OPENAI_API_KEY;
    client = apiKey
      ? new OpenAI({ apiKey, timeout: MODERATION_TIMEOUT_MS, maxRetries: 0 })
      : null;
  }
  return client;
}

/** Resolves to true only when the moderation model positively flags the text. */
export async function isHarmfulText(text: string): Promise<boolean> {
  const openai = getClient();
  if (!openai || !text.trim()) return false;

  try {
    const response = await openai.moderations.create({
      model: MODERATION_MODEL,
      input: text,
    });
    const result = response.results[0];
    if (!result) return false;
    const categories = result.categories as unknown as Record<string, boolean>;
    const scores = result.category_scores as unknown as Record<string, number>;
    const hit: string[] = [
      ...BLOCKED_CATEGORIES.filter((category) => categories[category]),
      ...Object.entries(SCORE_THRESHOLDS)
        .filter(([category, threshold]) => (scores[category] ?? 0) >= threshold)
        .map(([category]) => category),
    ];
    if (hit.length > 0) {
      console.log(`🛡️ Answer hidden by moderation (${hit.join(", ")})`);
      return true;
    }
    return false;
  } catch (error) {
    console.warn(
      "⚠️ Moderation check skipped:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
