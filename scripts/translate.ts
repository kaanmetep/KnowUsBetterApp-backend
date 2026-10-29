/**
 * Adds a language to the question bank.
 *
 *   npx tsx scripts/translate.ts translate [--lang pt] [--category we_just_met] [--limit 30]
 *   npx tsx scripts/translate.ts check     [--lang pt]
 *   npx tsx scripts/translate.ts sheet     [--lang pt]
 *   npx tsx scripts/translate.ts apply     [--lang pt] [--dry-run]
 *
 * translate  Questions without a translation in translations/<lang>/questions/<category>.json
 *            get a draft pass and a native-editor pass from OpenAI, are validated and
 *            written there. Safe to stop and rerun: finished questions are skipped.
 * check      Validates every file against the database and reports coverage.
 * sheet      Writes translations/<lang>/review.csv for a human reviewer, flagged rows first.
 * apply      Merges the files into the database in one transaction: texts.text_<lang>,
 *            answers.answers_<lang>, correct_answer.<lang> and the hand-written labels in
 *            translations/<lang>/labels.json. Other languages are never touched; a
 *            question whose English text changed after it was translated is skipped.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { getAdminPool } from "../src/utils/adminDb.js";
import { isLang, LANGUAGE_NAMES, type Lang } from "../src/languages.js";

// ---------- arguments ----------

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const LANG = (flag("lang") ?? "pt") as Lang;
if (!isLang(LANG) || LANG === "en") throw new Error(`Unknown target language: ${LANG}`);
const ONLY_CATEGORY = flag("category");
const LIMIT = flag("limit") ? Number(flag("limit")) : Infinity;
const DRY_RUN = args.includes("--dry-run");

const MODEL = process.env.TRANSLATE_MODEL || "gpt-5.5";
const BATCH_SIZE = 20;
const CONCURRENCY = 4;
const MAX_TEXT_LENGTH = 500;
const SOURCE_LANGS = ["en", "tr", "es"] as const;

const DIR = path.resolve("translations", LANG);
const QUESTIONS_DIR = path.join(DIR, "questions");
const LABELS_FILE = path.join(DIR, "labels.json");

// ---------- style ----------

const STYLE: Partial<Record<Lang, string>> = {
  pt: `Target: Brazilian Portuguese (pt-BR), for Brazilian couples and friends in their 20s-30s.
- Sound like a Brazilian wrote it for a fun app: casual, warm, natural spoken Portuguese. Never European Portuguese ("tu" conjugations, "telemóvel", "rapariga", "giro").
- Address the player as "você"; two players together as "vocês".
- Gender: the player and their partner can be any gender, so nothing that refers to them may need gender agreement. Avoid "(a)" / "o/a" forms; rephrase with verbs and nouns instead of adjectives ("Você tem ciúme?" not "Você é ciumento(a)?", "Você topa...?" not "Você está pronto(a)?").
- "your partner" is "seu amor" by default (warm and gender-neutral). Use "seu par" or "a pessoa com quem você está" only where "seu amor" sounds odd, e.g. a hypothetical future partner. Never "parceiro(a)" or "namorado(a)".
- Other people (friends, exes, strangers, "someone") take the ordinary masculine generic, as Brazilians naturally say it: "seu melhor amigo", "alguém mais baixo que você", "seus amigos". Don't contort these into "sua amizade" or "a pessoa amiga".
- In just_friends the partner is a friend: "seu amigo" is fine there.
- {{playerName}} is a first name; keep it exactly as written and build the sentence so it works for any gender ("Qual é o sabor de sorvete favorito de {{playerName}}?").
- "Who is more likely to ...?" becomes "Quem é mais provável de ...?" with an infinitive, the usual wording of this game in Brazil.
- Intimate categories: flirty and adult but never vulgar or clinical; everyday words Brazilian couples actually use.
- Keep it as short as the English; it is read in a few seconds on a phone.
- Brands, apps, shows and names stay as they are known in Brazil (Netflix, WhatsApp, "Friends").`,
};

const MODES: Record<string, string> = {
  see_your_match:
    "Both players answer the same question about themselves; matching answers raise their compatibility score. 'you' is the player answering.",
  know_each_other:
    "One player answers about themselves, the other guesses their answer. {{playerName}} is the player being asked about.",
  who_knows_better:
    "General-knowledge quiz graded against an answer key. Facts must stay exactly the same; use the standard Brazilian names of places, people and things.",
  who_is_more_likely:
    "Both players vote who fits the sentence better: me, my partner, both or neither. The text is always a 'Who is more likely to ...?' question.",
  rank_it:
    "Players drag the options into order. Keep the direction of the ranking (most to least, best to worst) and keep options short and parallel.",
};

// ---------- data ----------

type Row = {
  id: string;
  category_id: string;
  group_id: string | null;
  texts: Record<string, string>;
  question_type: "choice" | "text";
  answers: Record<string, string[]> | null;
  correct_answer: unknown;
};

type Entry = {
  /** English text when translated; a change means the translation is stale. */
  en: string;
  text: string;
  answers?: string[];
  accepted?: string[];
  flagged?: boolean;
  note?: string;
};

type CategoryFile = Record<string, Entry>;

async function loadRows(): Promise<Row[]> {
  const { rows } = await getAdminPool().query<Row>(
    `SELECT q.id, q.category_id, c.group_id, q.texts, q.question_type, q.answers, q.correct_answer
       FROM questions q LEFT JOIN categories c ON c.id = q.category_id
      ORDER BY q.category_id, q.order_index NULLS LAST, q.created_at`,
  );
  return rows;
}

const englishAnswers = (row: Row): string[] =>
  row.question_type === "choice" && Array.isArray(row.answers?.answers_en)
    ? row.answers!.answers_en
    : [];

/** Typed trivia keys stored per language (`{ en: [...], tr: [...] }`) get one too. */
const hasTypedKey = (row: Row): boolean =>
  row.correct_answer != null &&
  typeof row.correct_answer === "object" &&
  !Array.isArray(row.correct_answer);

const typedKey = (row: Row, lang: string): string[] =>
  hasTypedKey(row) ? ((row.correct_answer as Record<string, string[]>)[lang] ?? []) : [];

const fileOf = (category: string) => path.join(QUESTIONS_DIR, `${category}.json`);

function readFile(category: string): CategoryFile {
  const file = fileOf(category);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function writeFile(category: string, data: CategoryFile, order: string[]) {
  fs.mkdirSync(QUESTIONS_DIR, { recursive: true });
  const sorted = Object.fromEntries(order.filter((id) => data[id]).map((id) => [id, data[id]]));
  fs.writeFileSync(fileOf(category), JSON.stringify(sorted, null, 2) + "\n");
}

// ---------- validation ----------

// Repeats are fine: every consumer substitutes placeholders with a global replace.
const placeholders = (text: string) => [...new Set(text.match(/\{\{\s*\w+\s*\}\}/g) ?? [])].sort().join(",");

function validate(row: Row, entry: Pick<Entry, "text" | "answers" | "accepted">): string[] {
  const errors: string[] = [];
  const en = row.texts.text_en ?? "";
  const text = entry.text?.trim() ?? "";

  if (!text) errors.push("text is empty");
  if (text.length > MAX_TEXT_LENGTH) errors.push(`text is longer than ${MAX_TEXT_LENGTH}`);
  if (placeholders(text) !== placeholders(en)) {
    errors.push(`placeholders must be exactly: ${placeholders(en) || "none"}`);
  }
  if (/\{\{|\}\}/.test(text.replace(/\{\{\w+\}\}/g, ""))) errors.push("broken {{placeholder}}");
  if (/\([oa]\)|\bo\/a\b|\ba\/o\b/i.test(text)) errors.push('no "(a)" or "o/a" gender forms');
  if (en.length > 25 && text === en) errors.push("text is still English");

  const options = englishAnswers(row);
  const answers = entry.answers ?? [];
  if (options.length) {
    if (answers.length !== options.length) {
      errors.push(`needs exactly ${options.length} answers in the same order`);
    } else {
      const seen = new Set<string>();
      answers.forEach((answer, i) => {
        const value = answer?.trim() ?? "";
        if (!value) errors.push(`answer ${i + 1} is empty`);
        if (value.length > MAX_TEXT_LENGTH) errors.push(`answer ${i + 1} is too long`);
        if (seen.has(value.toLowerCase())) errors.push(`answer "${value}" is repeated`);
        seen.add(value.toLowerCase());
        // The server finds a picked answer by its text in any language, so it
        // must not equal a different option in another language.
        for (const lang of SOURCE_LANGS) {
          const list = row.answers?.[`answers_${lang}`] ?? [];
          const j = list.indexOf(value);
          if (j !== -1 && j !== i) {
            errors.push(`answer "${value}" is option ${j + 1} in ${lang}; it must stay option ${i + 1}`);
          }
        }
      });
    }
  } else if (answers.length) {
    errors.push("this question has no answer options; answers must be []");
  }

  const accepted = entry.accepted ?? [];
  if (hasTypedKey(row)) {
    if (!accepted.length) errors.push("accepted answers are missing");
    if (accepted.some((a) => !a?.trim() || a.length > MAX_TEXT_LENGTH)) {
      errors.push("accepted answers must be non-empty and short");
    }
  } else if (accepted.length) {
    errors.push("this question has no answer key; accepted must be []");
  }
  return errors;
}

// ---------- OpenAI ----------

const openai = new OpenAI();

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    key: { type: "string" },
    text: { type: "string" },
    answers: { type: "array", items: { type: "string" } },
    accepted: { type: "array", items: { type: "string" } },
    flag: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["key", "text", "answers", "accepted", "flag", "note"],
  additionalProperties: false,
} as const;

type Item = { key: string; text: string; answers: string[]; accepted: string[]; flag: boolean; note: string };

function sourceItem(row: Row, key: string) {
  const item: Record<string, unknown> = { key };
  for (const lang of SOURCE_LANGS) item[lang] = row.texts[`text_${lang}`] ?? "";
  const options = englishAnswers(row);
  if (options.length) {
    for (const lang of SOURCE_LANGS) item[`answers_${lang}`] = row.answers?.[`answers_${lang}`] ?? [];
  }
  if (typeof row.correct_answer === "string" && options.length) item.correct_answer_en = row.correct_answer;
  if (hasTypedKey(row)) {
    for (const lang of SOURCE_LANGS) item[`accepted_${lang}`] = typedKey(row, lang);
  }
  return item;
}

function context(category: string, group: string | null): string {
  return `Category: ${category}. Game mode: ${MODES[group ?? ""] ?? MODES.see_your_match}`;
}

const RULES = `Output rules:
- One item per input item, same "key".
- "text": the question in the target language.
- "answers": only when the input has answers_en: the options translated in the SAME order and count, each short and distinct. Otherwise [].
- "accepted": only when the input has accepted_en: accepted typed answers in the target language, most common spelling first, plus common alternatives and abbreviations (the English name too if Brazilians use it). Otherwise [].
- "flag": true when a human should look (cultural reference that doesn't land in Brazil, ambiguous source, a trivia fact that depends on the country, wording you're unsure about). Otherwise false.
- "note": short reason when flagged, in English. Otherwise "".
- English is the source of truth for meaning; Turkish and Spanish show nuance and tone. Translate meaning, not words.`;

async function ask(system: string, payload: unknown, expected: string[]): Promise<Map<string, Item>> {
  for (let attempt = 1; ; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        reasoning_effort: "medium",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "translations",
            strict: true,
            schema: {
              type: "object",
              properties: { items: { type: "array", items: ITEM_SCHEMA } },
              required: ["items"],
              additionalProperties: false,
            },
          },
        },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
      });
      const content = completion.choices[0]?.message?.content ?? "";
      const items = (JSON.parse(content).items ?? []) as Item[];
      const byKey = new Map(items.map((item) => [item.key, item]));
      const missing = expected.filter((key) => !byKey.has(key));
      if (missing.length) throw new Error(`missing keys ${missing.join(", ")}`);
      return byKey;
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`  retry ${attempt}: ${error instanceof Error ? error.message : error}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function translateBatch(rows: Row[], category: string, group: string | null) {
  const language = LANGUAGE_NAMES[LANG];
  const keys = rows.map((_, i) => String(i + 1));
  const sources = rows.map((row, i) => sourceItem(row, keys[i]));

  const draft = await ask(
    `You translate questions for KnowUsBetter, a quiz game for couples and friends, into ${language}.\n${context(category, group)}\n\n${STYLE[LANG] ?? ""}\n\n${RULES}`,
    { items: sources },
    keys,
  );

  const reviewed = await ask(
    `You are a native ${language} editor checking translations for KnowUsBetter, a quiz game for couples and friends.\n${context(category, group)}\n\n${STYLE[LANG] ?? ""}\n\nEach item has the source and a "draft". Fix anything inaccurate, unnatural, too long, gendered against the rules, or that a native speaker wouldn't say; keep the draft when it is already good. Return the final version.\n\n${RULES}`,
    {
      items: sources.map((source, i) => {
        const d = draft.get(keys[i])!;
        return { ...source, draft: { text: d.text, answers: d.answers, accepted: d.accepted, note: d.note } };
      }),
    },
    keys,
  );

  return rows.map((row, i) => {
    const item = reviewed.get(keys[i])!;
    const draftItem = draft.get(keys[i])!;
    return { row, item: { ...item, flag: item.flag || draftItem.flag, note: item.note || draftItem.note } };
  });
}

/** One retry per invalid question, told what was wrong. */
async function fixOne(row: Row, item: Item, errors: string[], group: string | null): Promise<Item> {
  const fixed = await ask(
    `You translate questions for KnowUsBetter, a quiz game for couples and friends, into ${LANGUAGE_NAMES[LANG]}.\n${context(row.category_id, group)}\n\n${STYLE[LANG] ?? ""}\n\n${RULES}\n\nThe previous translation was rejected: ${errors.join("; ")}. Fix it.`,
    { items: [{ ...sourceItem(row, "1"), rejected: { text: item.text, answers: item.answers, accepted: item.accepted } }] },
    ["1"],
  );
  return fixed.get("1")!;
}

async function pool<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

// ---------- commands ----------

async function translate() {
  const rows = await loadRows();
  const byCategory = new Map<string, Row[]>();
  for (const row of rows) {
    if (ONLY_CATEGORY && row.category_id !== ONLY_CATEGORY) continue;
    byCategory.set(row.category_id, [...(byCategory.get(row.category_id) ?? []), row]);
  }

  let budget = LIMIT;
  const failed: string[] = [];
  for (const [category, categoryRows] of byCategory) {
    const done = readFile(category);
    const todo = categoryRows
      .filter((row) => done[row.id]?.en !== row.texts.text_en)
      .slice(0, Math.max(0, budget));
    budget -= todo.length;
    if (!todo.length) continue;

    const group = categoryRows[0].group_id;
    const order = categoryRows.map((row) => row.id);
    console.log(`${category}: ${todo.length} to translate`);

    const batches: Row[][] = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

    await pool(
      batches.map((batch, b) => async () => {
        const results = await translateBatch(batch, category, group);
        for (const { row, item } of results) {
          let final = item;
          let errors = validate(row, final);
          if (errors.length) {
            final = await fixOne(row, final, errors, group);
            errors = validate(row, final);
          }
          if (errors.length) {
            failed.push(`${category}/${row.id}: ${errors.join("; ")}\n    got: ${final.text}`);
            continue;
          }
          done[row.id] = {
            en: row.texts.text_en,
            text: final.text.trim(),
            ...(englishAnswers(row).length && { answers: final.answers.map((a) => a.trim()) }),
            ...(hasTypedKey(row) && { accepted: final.accepted.map((a) => a.trim()) }),
            ...(final.flag && { flagged: true }),
            ...(final.note && { note: final.note }),
          };
        }
        writeFile(category, done, order);
        console.log(`  ${category} batch ${b + 1}/${batches.length} saved`);
      }),
      CONCURRENCY,
    );
  }

  if (failed.length) {
    console.log(`\n${failed.length} question(s) failed validation and were not saved:`);
    failed.forEach((line) => console.log(`  ${line}`));
    process.exitCode = 1;
  }
}

type Report = { total: number; done: number; missing: string[]; stale: string[]; invalid: string[]; flagged: number };

async function check(rows?: Row[]): Promise<Report> {
  rows ??= await loadRows();
  const report: Report = { total: rows.length, done: 0, missing: [], stale: [], invalid: [], flagged: 0 };
  const files = new Map<string, CategoryFile>();
  const known = new Set(rows.map((row) => row.id));

  for (const row of rows) {
    if (!files.has(row.category_id)) files.set(row.category_id, readFile(row.category_id));
    const entry = files.get(row.category_id)![row.id];
    if (!entry) {
      report.missing.push(`${row.category_id}/${row.id}`);
      continue;
    }
    if (entry.en !== row.texts.text_en) {
      report.stale.push(`${row.category_id}/${row.id}`);
      continue;
    }
    const errors = validate(row, entry);
    if (errors.length) {
      report.invalid.push(`${row.category_id}/${row.id}: ${errors.join("; ")}`);
      continue;
    }
    report.done++;
    if (entry.flagged) report.flagged++;
  }

  const orphans = fs.existsSync(QUESTIONS_DIR)
    ? fs
        .readdirSync(QUESTIONS_DIR)
        .flatMap((name) => Object.keys(JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, name), "utf8"))))
        .filter((id) => !known.has(id))
    : [];

  console.log(
    `${LANG}: ${report.done}/${report.total} ready · ${report.flagged} flagged for review · ` +
      `${report.missing.length} missing · ${report.stale.length} stale · ${report.invalid.length} invalid · ` +
      `${orphans.length} for deleted questions`,
  );
  for (const line of report.invalid) console.log(`  invalid ${line}`);
  for (const line of report.stale) console.log(`  stale ${line}`);
  if (report.missing.length && report.missing.length <= 20) {
    for (const line of report.missing) console.log(`  missing ${line}`);
  }
  return report;
}

function csv(values: unknown[]): string {
  return values.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
}

async function sheet() {
  const rows = await loadRows();
  const lines = [csv(["flagged", "note", "category", "id", "english", LANG, "answers_en", `answers_${LANG}`, `accepted_${LANG}`])];
  const entries = rows
    .map((row) => ({ row, entry: readFile(row.category_id)[row.id] }))
    .filter((x) => x.entry)
    .sort((a, b) => Number(!!b.entry.flagged) - Number(!!a.entry.flagged));
  for (const { row, entry } of entries) {
    lines.push(
      csv([
        entry.flagged ? "yes" : "",
        entry.note,
        row.category_id,
        row.id,
        row.texts.text_en,
        entry.text,
        englishAnswers(row).join(" | "),
        (entry.answers ?? []).join(" | "),
        (entry.accepted ?? []).join(" | "),
      ]),
    );
  }
  const file = path.join(DIR, "review.csv");
  fs.writeFileSync(file, "\uFEFF" + lines.join("\n") + "\n");
  console.log(`Wrote ${entries.length} rows to ${path.relative(process.cwd(), file)}`);
}

type Labels = {
  categories?: Record<string, { category: string; short?: string }>;
  category_groups?: Record<string, { category: string }>;
  game_reactions?: Record<string, string>;
  announcements?: Record<string, { title: string; message: string }>;
};

async function apply() {
  const rows = await loadRows();
  const report = await check(rows);
  if (report.invalid.length) throw new Error("Fix the invalid translations first (see above).");

  const db = await getAdminPool().connect();
  let questions = 0;
  try {
    await db.query("BEGIN");
    for (const row of rows) {
      const entry = readFile(row.category_id)[row.id];
      if (!entry || entry.en !== row.texts.text_en) continue;
      const { rowCount } = await db.query(
        `UPDATE questions SET
           texts = texts || jsonb_build_object($2::text, $3::text),
           answers = CASE WHEN $5::jsonb IS NULL OR answers IS NULL THEN answers
                          ELSE answers || jsonb_build_object($4::text, $5::jsonb) END,
           correct_answer = CASE WHEN $7::jsonb IS NULL OR jsonb_typeof(correct_answer) <> 'object' THEN correct_answer
                                 ELSE correct_answer || jsonb_build_object($6::text, $7::jsonb) END
         WHERE id = $1 AND texts->>'text_en' = $8`,
        [
          row.id,
          `text_${LANG}`,
          entry.text,
          `answers_${LANG}`,
          entry.answers ? JSON.stringify(entry.answers) : null,
          LANG,
          entry.accepted ? JSON.stringify(entry.accepted) : null,
          entry.en,
        ],
      );
      questions += rowCount ?? 0;
    }

    const labels: Labels = fs.existsSync(LABELS_FILE) ? JSON.parse(fs.readFileSync(LABELS_FILE, "utf8")) : {};
    let labelRows = 0;
    for (const [id, l] of Object.entries(labels.categories ?? {})) {
      const add: Record<string, string> = { [`category_${LANG}`]: l.category };
      if (l.short) add[`short_${LANG}`] = l.short;
      const r = await db.query(`UPDATE categories SET labels = COALESCE(labels, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [id, add]);
      labelRows += r.rowCount ?? 0;
    }
    for (const [id, l] of Object.entries(labels.category_groups ?? {})) {
      const r = await db.query(`UPDATE category_groups SET labels = COALESCE(labels, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [
        id,
        { [`category_${LANG}`]: l.category },
      ]);
      labelRows += r.rowCount ?? 0;
    }
    for (const [id, label] of Object.entries(labels.game_reactions ?? {})) {
      const r = await db.query(`UPDATE game_reactions SET labels = COALESCE(labels, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [
        id,
        { [LANG]: label },
      ]);
      labelRows += r.rowCount ?? 0;
    }
    for (const [id, a] of Object.entries(labels.announcements ?? {})) {
      const r = await db.query(
        `UPDATE announcements SET title = COALESCE(title, '{}'::jsonb) || $2::jsonb,
                                  message = COALESCE(message, '{}'::jsonb) || $3::jsonb
          WHERE id = $1`,
        [id, { [LANG]: a.title }, { [LANG]: a.message }],
      );
      labelRows += r.rowCount ?? 0;
    }

    await db.query(DRY_RUN ? "ROLLBACK" : "COMMIT");
    console.log(
      `${DRY_RUN ? "Dry run, nothing saved: would update" : "Updated"} ${questions} questions and ${labelRows} label rows (${LANG}).`,
    );
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

const commands: Record<string, () => Promise<unknown>> = { translate, check: () => check(), sheet, apply };
const run = commands[command];
if (!run) {
  console.log("Usage: npx tsx scripts/translate.ts <translate|check|sheet|apply> [--lang pt] [--category id] [--limit n] [--dry-run]");
  process.exit(1);
}
run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getAdminPool().end());
