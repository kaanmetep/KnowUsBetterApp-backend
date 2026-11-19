// Search every category's question text and answer options (all 4 languages) for a regex.
// Use it before adding a question to catch near-duplicates in other modes too.
//   npx tsx --env-file=.env scripts/questions/search.ts "tattoo|dövme"
import { listCategories, listQuestions } from "../../src/services/adminQuestionService.ts";
import { getAdminPool } from "../../src/utils/adminDb.ts";

const pattern = process.argv[2];
if (!pattern) throw new Error('Usage: search.ts "<regex>"');
const re = new RegExp(pattern, "i");

for (const c of await listCategories()) {
  for (const q of await listQuestions(c.id)) {
    const haystack = [
      ...Object.values(q.texts ?? {}),
      ...(q.answers ? Object.values(q.answers).flat() : []),
    ].join(" | ");
    if (re.test(haystack)) {
      const answers = q.have_answers ? ` [${q.answers.answers_en.join(" / ")}]` : "";
      console.log(`${c.id} (${c.group_id}): ${q.texts.text_en}${answers}`);
    }
  }
}
await getAdminPool().end();
