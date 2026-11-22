// Insert questions into the LIVE database, through the same validation and insert
// code the admin panel uses (validateQuestionInput + createQuestion).
//   npx tsx --env-file=.env scripts/questions/add.ts batch.json            → dry run, validates only
//   npx tsx --env-file=.env scripts/questions/add.ts batch.json --commit   → writes
// batch.json is an array of admin-panel payloads; see the write-questions skill for shapes.
import { readFileSync } from "fs";
import { validateQuestionInput, createQuestion } from "../../src/services/adminQuestionService.ts";
import { getAdminPool } from "../../src/utils/adminDb.ts";

const file = process.argv[2];
if (!file) throw new Error("Usage: add.ts <batch.json> [--commit]");
const commit = process.argv.includes("--commit");
const inputs = JSON.parse(readFileSync(file, "utf8")).map((b: any) => validateQuestionInput(b)); // throws before any write

for (const input of inputs) {
  if (!commit) {
    console.log("DRY OK:", input.category_id, input.texts.text_en);
    continue;
  }
  const row = await createQuestion(input);
  console.log("ADDED:", row.id, row.category_id, `#${row.order_index}`, row.texts.text_en);
}
await getAdminPool().end();
