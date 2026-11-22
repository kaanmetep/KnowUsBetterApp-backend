// Live question bank, read-only.
//   npx tsx --env-file=.env scripts/questions/list.ts                 → every category with group + count
//   npx tsx --env-file=.env scripts/questions/list.ts <category>      → all questions of one category
//   npx tsx --env-file=.env scripts/questions/list.ts <category> --group
//        → that category plus every sibling category in the same game mode (group_id)
import { listCategories, listQuestions } from "../../src/services/adminQuestionService.ts";
import { getAdminPool } from "../../src/utils/adminDb.ts";

const [cat] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const withGroup = process.argv.includes("--group");

function printQuestions(categoryId: string, rows: any[]) {
  console.log(`\n# ${categoryId} — ${rows.length} questions`);
  [...rows].reverse().forEach((q, i) => {
    const kind = q.question_type === "text" ? "text" : q.have_answers ? `choice/${q.answers.answers_en.length}` : "yesno";
    const answers = q.have_answers ? ` [${q.answers.answers_en.join(" / ")}]` : "";
    const weight = q.match_weight ? ` w${q.match_weight}` : "";
    const key = q.correct_answer != null ? ` ✓${JSON.stringify(q.correct_answer)}` : "";
    console.log(`${i + 1}. (${kind}${weight}) ${q.texts.text_en} || ${q.texts.text_tr}${answers}${key}`);
  });
}

const categories = await listCategories();
if (!cat) {
  for (const c of categories) console.log(`${c.id} | ${c.group_id} | ${c.question_count}${c.is_trivia ? " | TRIVIA" : ""}`);
} else {
  const target = categories.find((c: any) => c.id === cat);
  if (!target) throw new Error(`Unknown category: ${cat}`);
  const ids = withGroup ? categories.filter((c: any) => c.group_id === target.group_id).map((c: any) => c.id) : [cat];
  for (const id of ids) printQuestions(id, await listQuestions(id));
}
await getAdminPool().end();
