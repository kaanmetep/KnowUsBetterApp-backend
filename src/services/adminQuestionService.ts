import crypto from "crypto";
import { getAdminPool } from "../utils/adminDb.js";
import { AppError } from "../errors/AppError.js";
import { MAX_MATCH_WEIGHT, MIN_MATCH_WEIGHT } from "../types.js";

const LANGS = ["en", "tr", "es"] as const;
const MAX_TEXT_LENGTH = 500;
const MIN_ANSWERS = 2;
const MAX_ANSWERS = 8;

const QUESTION_TYPES = ["choice", "text"] as const;

// Every question in these must have a correct_answer; the game skips the ones without.
const TRIVIA_CATEGORY_IDS = ["trivia_master", "mastermind"];

export interface QuestionInput {
  category_id: string;
  texts: { text_en: string; text_tr: string; text_es: string };
  question_type: (typeof QUESTION_TYPES)[number];
  have_answers: boolean;
  answers: { answers_en: string[]; answers_tr: string[]; answers_es: string[] } | null;
  /** Trivia answer key; shapes in migrations/20261007_trivia_correct_answer.sql. */
  correct_answer: string | { en: string[]; tr: string[]; es: string[] } | null;
  /** see_your_match weight 1-10; null = default. Never set on trivia questions. */
  match_weight: number | null;
}

function validateMatchWeight(
  raw: unknown,
  correct_answer: QuestionInput["correct_answer"],
): number | null {
  if (raw == null || raw === "") return null;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_MATCH_WEIGHT ||
    value > MAX_MATCH_WEIGHT
  ) {
    throw new AppError(
      `match_weight must be a whole number between ${MIN_MATCH_WEIGHT} and ${MAX_MATCH_WEIGHT}`,
      400,
      "VALIDATION_ERROR",
    );
  }
  if (correct_answer != null) {
    throw new AppError("Trivia questions can't have a match_weight", 400, "VALIDATION_ERROR");
  }
  return value;
}

/**
 * Same rules as the questions_correct_answer_shape_check constraint, with
 * readable errors. Empty / missing means "not a trivia question".
 */
function validateCorrectAnswer(
  raw: unknown,
  question_type: QuestionInput["question_type"],
  answers: QuestionInput["answers"],
): QuestionInput["correct_answer"] {
  if (raw == null || raw === "") return null;

  if (question_type === "text") {
    const lists =
      typeof raw === "object" && !Array.isArray(raw)
        ? LANGS.map((lang) => (raw as Record<string, unknown>)[lang])
        : [raw, raw, raw];
    const [en, tr, es] = lists.map((list, i) =>
      (Array.isArray(list) ? list : list == null ? [] : [list]).map(
        (item: unknown, j: number) => cleanString(item, `correct_answer.${LANGS[i]}[${j}]`),
      ),
    );
    if (!en.length && !tr.length && !es.length) return null;
    return { en, tr, es };
  }

  const value = cleanString(raw, "correct_answer");
  if (!answers) {
    const yesNo = value.toLowerCase();
    if (yesNo !== "yes" && yesNo !== "no") {
      throw new AppError('Yes/no question: correct_answer must be "yes" or "no"', 400, "VALIDATION_ERROR");
    }
    return yesNo;
  }
  if (!answers.answers_en.includes(value)) {
    throw new AppError(
      "Multiple choice: correct_answer must be one of the English answers",
      400,
      "VALIDATION_ERROR",
    );
  }
  return value;
}

function cleanString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(`${field} is required`, 400, "VALIDATION_ERROR");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new AppError(`${field} is too long`, 400, "VALIDATION_ERROR");
  }
  return trimmed;
}

export function validateQuestionInput(body: any): QuestionInput {
  if (!body || typeof body !== "object") {
    throw new AppError("Invalid payload", 400, "VALIDATION_ERROR");
  }

  const category_id = cleanString(body.category_id, "category_id");
  const texts = {
    text_en: cleanString(body.texts?.text_en, "texts.text_en"),
    text_tr: cleanString(body.texts?.text_tr, "texts.text_tr"),
    text_es: cleanString(body.texts?.text_es, "texts.text_es"),
  };
  const question_type = body.question_type ?? "choice";
  if (!QUESTION_TYPES.includes(question_type)) {
    throw new AppError("question_type must be choice or text", 400, "VALIDATION_ERROR");
  }

  // Text questions are typed freely, so they never carry an answer list.
  const have_answers = question_type === "choice" && body.have_answers === true;

  if (!have_answers) {
    const correct_answer = validateCorrectAnswer(body.correct_answer, question_type, null);
    return {
      category_id,
      texts,
      question_type,
      have_answers,
      answers: null,
      correct_answer,
      match_weight: validateMatchWeight(body.match_weight, correct_answer),
    };
  }

  const lists = LANGS.map((lang) => {
    const list = body.answers?.[`answers_${lang}`];
    if (!Array.isArray(list)) {
      throw new AppError(`answers.answers_${lang} must be an array`, 400, "VALIDATION_ERROR");
    }
    return list.map((item: unknown, i: number) =>
      cleanString(item, `answers.answers_${lang}[${i}]`),
    );
  });

  const count = lists[0].length;
  if (lists.some((list) => list.length !== count)) {
    throw new AppError("Every language needs the same number of answers", 400, "VALIDATION_ERROR");
  }
  if (count < MIN_ANSWERS || count > MAX_ANSWERS) {
    throw new AppError(
      `Answer count must be between ${MIN_ANSWERS} and ${MAX_ANSWERS}`,
      400,
      "VALIDATION_ERROR",
    );
  }
  if (new Set(lists[0].map((a) => a.toLowerCase())).size !== count) {
    throw new AppError("English answers must be unique", 400, "VALIDATION_ERROR");
  }

  const answers = { answers_en: lists[0], answers_tr: lists[1], answers_es: lists[2] };
  const correct_answer = validateCorrectAnswer(body.correct_answer, question_type, answers);
  return {
    category_id,
    texts,
    question_type,
    have_answers,
    answers,
    correct_answer,
    match_weight: validateMatchWeight(body.match_weight, correct_answer),
  };
}

// node-postgres sends plain strings as-is (not valid JSON) and arrays as
// Postgres arrays, so jsonb values are serialized up front.
const toJsonb = (value: unknown) => (value == null ? null : JSON.stringify(value));

async function assertValidCategory(input: QuestionInput): Promise<void> {
  const { rowCount } = await getAdminPool().query("SELECT 1 FROM categories WHERE id = $1", [
    input.category_id,
  ]);
  if (!rowCount) {
    throw new AppError(`Unknown category: ${input.category_id}`, 400, "VALIDATION_ERROR");
  }
  if (TRIVIA_CATEGORY_IDS.includes(input.category_id) && input.correct_answer == null) {
    throw new AppError(
      `Questions in ${input.category_id} need a correct_answer`,
      400,
      "VALIDATION_ERROR",
    );
  }
}

export async function listCategories() {
  const { rows } = await getAdminPool().query(
    `SELECT c.id, c.labels, c.group_id, c.difficulty, c.order_index, COUNT(q.id)::int AS question_count,
            c.id = ANY($1) AS is_trivia
       FROM categories c
       LEFT JOIN questions q ON q.category_id = c.id
      GROUP BY c.id
      ORDER BY c.order_index, c.id`,
    [TRIVIA_CATEGORY_IDS],
  );
  return rows;
}

export async function listQuestions(categoryId: string) {
  const { rows } = await getAdminPool().query(
    `SELECT id, category_id, texts, question_type, have_answers, answers, correct_answer, match_weight, order_index, created_at, updated_at
       FROM questions
      WHERE category_id = $1
      ORDER BY order_index DESC NULLS LAST, created_at DESC`,
    [categoryId],
  );
  return rows;
}

export async function createQuestion(input: QuestionInput) {
  await assertValidCategory(input);
  const { rows } = await getAdminPool().query(
    `INSERT INTO questions (id, category_id, texts, have_answers, answers, question_type, correct_answer, match_weight, order_index, created_at, updated_at)
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       (SELECT COALESCE(MAX(order_index), 0) + 1 FROM questions WHERE category_id = $2),
       now(), now()
     )
     RETURNING *`,
    [
      crypto.randomUUID(),
      input.category_id,
      input.texts,
      input.have_answers,
      input.answers,
      input.question_type,
      toJsonb(input.correct_answer),
      input.match_weight,
    ],
  );
  return rows[0];
}

export async function updateQuestion(id: string, input: QuestionInput) {
  await assertValidCategory(input);
  const { rows } = await getAdminPool().query(
    `UPDATE questions
        SET category_id = $2, texts = $3, have_answers = $4, answers = $5, question_type = $6,
            correct_answer = $7, match_weight = $8, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      id,
      input.category_id,
      input.texts,
      input.have_answers,
      input.answers,
      input.question_type,
      toJsonb(input.correct_answer),
      input.match_weight,
    ],
  );
  if (!rows[0]) {
    throw new AppError("Question not found", 404, "NOT_FOUND");
  }
  return rows[0];
}

export async function deleteQuestion(id: string): Promise<void> {
  const { rowCount } = await getAdminPool().query("DELETE FROM questions WHERE id = $1", [id]);
  if (!rowCount) {
    throw new AppError("Question not found", 404, "NOT_FOUND");
  }
}
