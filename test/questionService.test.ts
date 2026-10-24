import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchRandomQuestions,
  markQuestionsSeen,
} from "../src/services/questionService.js";

type Call = { fn: string; args: Record<string, unknown> };

const row = (n: number) => ({
  id: `q${n}`,
  category_id: "long_term",
  texts: { text_en: `Q${n}`, text_tr: `S${n}`, text_es: `P${n}` },
  have_answers: false,
  answers: null,
  question_type: "choice",
  match_weight: null,
});

/** Supabase stand-in: rpc results by function name, every table read empty. */
function fakeSupabase(results: Record<string, { data?: any; error?: any }>) {
  const calls: Call[] = [];
  const query = {
    select: () => query,
    in: async () => ({ data: [], error: null }),
  };
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const result = results[fn];
      if (!result) return { data: null, error: { code: "PGRST202" } };
      return { data: result.data ?? null, error: result.error ?? null };
    },
    from: () => query,
  };
}

test("picks unseen questions for the players when they are known", async () => {
  const db = fakeSupabase({
    get_fresh_questions: { data: [3, 1, 2].map(row) },
  });
  const questions = await fetchRandomQuestions("long_term", 2, db, {
    appUserIds: ["u1", "u2"],
  });
  assert.deepEqual(db.calls.map((c) => c.fn), ["get_fresh_questions"]);
  assert.deepEqual(db.calls[0].args, {
    p_category_id: "long_term",
    p_count: 6,
    p_app_user_ids: ["u1", "u2"],
  });
  assert.deepEqual(questions.map((q) => q.id), ["q3", "q1"]);
});

test("falls back to plain random when get_fresh_questions fails", async () => {
  const db = fakeSupabase({
    get_random_questions: { data: [1, 2].map(row) },
  });
  const questions = await fetchRandomQuestions("long_term", 2, db, {
    appUserIds: ["u1"],
  });
  assert.deepEqual(db.calls.map((c) => c.fn), [
    "get_fresh_questions",
    "get_random_questions",
  ]);
  assert.equal(questions.length, 2);
});

test("uses plain random when no player is known", async () => {
  const db = fakeSupabase({
    get_random_questions: { data: [1].map(row) },
  });
  await fetchRandomQuestions("long_term", 1, db, { appUserIds: [] });
  await fetchRandomQuestions("long_term", 1, db);
  assert.deepEqual(db.calls.map((c) => c.fn), [
    "get_random_questions",
    "get_random_questions",
  ]);
});

test("unseen order survives the text filter", async () => {
  const text = { ...row(9), question_type: "text" };
  const db = fakeSupabase({
    get_fresh_questions: { data: [text, row(4), row(5), row(6)] },
  });
  const questions = await fetchRandomQuestions("long_term", 2, db, {
    includeText: false,
    appUserIds: ["u1"],
  });
  assert.deepEqual(questions.map((q) => q.id), ["q4", "q5"]);
});

test("markQuestionsSeen sends both players and the questions", async () => {
  const db = fakeSupabase({ mark_questions_seen: {} });
  await markQuestionsSeen(["u1", "u2"], ["q1"], db);
  assert.deepEqual(db.calls, [
    {
      fn: "mark_questions_seen",
      args: { p_app_user_ids: ["u1", "u2"], p_question_ids: ["q1"] },
    },
  ]);
});

test("markQuestionsSeen skips empty input and never throws", async () => {
  const db = fakeSupabase({});
  await markQuestionsSeen([], ["q1"], db);
  await markQuestionsSeen(["u1"], [], db);
  await markQuestionsSeen(["u1"], ["q1"], null);
  assert.equal(db.calls.length, 0);

  await assert.doesNotReject(markQuestionsSeen(["u1"], ["q1"], db));
  const throwing = {
    rpc: async () => {
      throw new Error("network down");
    },
  };
  await assert.doesNotReject(markQuestionsSeen(["u1"], ["q1"], throwing));
});
