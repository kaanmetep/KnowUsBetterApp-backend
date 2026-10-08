import { Question, Category, QuestionType } from "../types.js";
import { AnswerKey, parseAnswerKey } from "../utils/trivia.js";

// Raw `correct_answer` per question id. Answer keys don't change during a game
// and must not ride along on the room (it's sent to clients), so they live here.
const ANSWER_KEY_CACHE_LIMIT = 5000;
const answerKeyCache = new Map<string, unknown>();

function cacheAnswerKey(id: string, raw: unknown) {
  if (answerKeyCache.size >= ANSWER_KEY_CACHE_LIMIT) {
    const oldest = answerKeyCache.keys().next().value;
    if (oldest !== undefined) answerKeyCache.delete(oldest);
  }
  answerKeyCache.set(id, raw);
}

/**
 * Reads `correct_answer` for these ids into the cache. Failures (e.g. the
 * column isn't migrated yet) leave every question as a regular one.
 */
async function loadAnswerKeys(ids: string[], supabaseAdmin: any): Promise<void> {
  if (!ids.length) return;
  try {
    const { data, error } = await supabaseAdmin
      .from("questions")
      .select("id, correct_answer")
      .in("id", ids);
    if (error) throw error;
    for (const row of data || []) cacheAnswerKey(row.id, row.correct_answer ?? null);
  } catch (error) {
    console.warn("⚠️ Could not read correct_answer, no trivia grading:", error);
  }
}

/** The answer key of a trivia question; fetched again if this process hasn't seen it. */
export async function getAnswerKey(
  question: Question,
  supabaseAdmin: any,
): Promise<AnswerKey | null> {
  if (!answerKeyCache.has(question.id) && supabaseAdmin) {
    await loadAnswerKeys([question.id], supabaseAdmin);
  }
  const key = parseAnswerKey(answerKeyCache.get(question.id), question);
  if (key) question.isTrivia = true;
  return key;
}

// Questions can be filtered out after the RPC (text questions for old clients,
// keyless questions in trivia categories), so it is asked for extra rows.
const OVERFETCH_FACTOR = 3;

const parseQuestionType = (value: unknown): QuestionType =>
  value === "text" ? "text" : "choice";

/**
 * The RPC may return a fixed column list that predates `question_type`; in that
 * case look the types up directly. Any failure (e.g. the column doesn't exist
 * yet) falls back to treating every question as "choice", i.e. the old behavior.
 */
async function resolveQuestionTypes(
  rows: any[],
  supabaseAdmin: any
): Promise<Map<string, QuestionType>> {
  const types = new Map<string, QuestionType>();
  const missing: string[] = [];

  for (const row of rows) {
    if (row && "question_type" in row) {
      types.set(row.id, parseQuestionType(row.question_type));
    } else if (row?.id) {
      missing.push(row.id);
    }
  }

  if (missing.length === 0) return types;

  try {
    const { data, error } = await supabaseAdmin
      .from("questions")
      .select("id, question_type")
      .in("id", missing);

    if (error) throw error;

    for (const row of data || []) {
      types.set(row.id, parseQuestionType(row.question_type));
    }
  } catch (error) {
    console.warn(
      "⚠️ Could not read question_type, treating questions as choice:",
      error
    );
  }

  return types;
}

/**
 * Fetch random questions from Supabase using RPC function
 * Randomization is done at database level using PostgreSQL's RANDOM() function
 * @param category - Question category (category_id in database)
 * @param count - Number of questions to fetch (default: 10)
 * @param supabaseAdmin - Supabase admin client (with service role key)
 * @param options.includeText - false drops free-text questions (some player's app can't show them)
 * @returns Array of questions
 */
export async function fetchRandomQuestions(
  category: Category,
  count: number,
  supabaseAdmin: any,
  options: { includeText?: boolean } = {}
): Promise<Question[]> {
  if (!supabaseAdmin) {
    throw new Error("Supabase admin client is required");
  }

  const includeText = options.includeText ?? true;

  try {
    // Call Supabase RPC function to get random questions
    // The function is defined in Supabase database (see SQL migration)
    // Always overfetch: text questions may be dropped below, and in a trivia
    // category so are questions that have no answer key.
    const { data, error } = await supabaseAdmin.rpc("get_random_questions", {
      p_category_id: category,
      p_count: count * OVERFETCH_FACTOR,
    });

    if (error) {
      console.error("Error fetching questions from Supabase RPC:", error);
      throw new Error("Failed to fetch questions");
    }

    if (!data || data.length === 0) {
      console.error("No questions found for category:", category);
      throw new Error("No questions available");
    }

    const types = await resolveQuestionTypes(data, supabaseAdmin);

    // Map database results to Question interface
    const questions: Question[] = data.map((q: any) => {
      // Handle texts: ensure all language fields exist
      const texts =
        q.texts && typeof q.texts === "object" && !Array.isArray(q.texts)
          ? {
              text_en: q.texts.text_en || "",
              text_tr: q.texts.text_tr || "",
              text_es: q.texts.text_es || "",
            }
          : {
              text_en: "",
              text_tr: "",
              text_es: "",
            };

      const questionType = types.get(q.id) ?? "choice";

      // Handle answers: multi-language object or null
      let answers: Question["answers"] = null;

      if (
        questionType === "choice" &&
        q.answers !== null &&
        q.answers !== undefined &&
        typeof q.answers === "object" &&
        !Array.isArray(q.answers) &&
        ("answers_en" in q.answers ||
          "answers_tr" in q.answers ||
          "answers_es" in q.answers)
      ) {
        // Multi-language format: { answers_en: [], answers_tr: [], answers_es: [] }
        answers = {
          answers_en: q.answers.answers_en || [],
          answers_tr: q.answers.answers_tr || [],
          answers_es: q.answers.answers_es || [],
        };
      }
      // Otherwise keep as null (for yes/no questions or invalid data)

      return {
        id: q.id,
        texts: texts,
        category: q.category_id,
        haveAnswers: questionType === "choice" && (q.have_answers || false),
        answers: answers,
        questionType,
      };
    });

    const candidates = includeText
      ? questions
      : questions.filter((q) => q.questionType !== "text");

    await loadAnswerKeys(
      candidates.map((q) => q.id),
      supabaseAdmin
    );
    for (const q of candidates) {
      if (parseAnswerKey(answerKeyCache.get(q.id), q)) q.isTrivia = true;
    }

    // A trivia game can't grade a question without a key, so once any
    // question in the category has one, the ones without are left out.
    const keyed = candidates.filter((q) => q.isTrivia);
    if (keyed.length > 0 && keyed.length < candidates.length) {
      console.warn(
        `⚠️ ${candidates.length - keyed.length} question(s) in trivia category ${category} have no correct_answer and were skipped`
      );
    }
    const playable = (keyed.length > 0 ? keyed : candidates).slice(0, count);

    if (playable.length === 0) {
      console.error("No playable questions found for category:", category);
      throw new Error("No questions available");
    }

    if (playable.length < count) {
      console.warn(
        `⚠️ Only found ${playable.length} questions in category, requested ${count}`
      );
    }

    return playable;
  } catch (error) {
    console.error("Error in fetchRandomQuestions:", error);
    throw error;
  }
}
