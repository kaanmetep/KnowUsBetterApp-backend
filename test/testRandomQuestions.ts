import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { fetchRandomQuestions } from "../src/services/questionService.js";
import { Category } from "../src/types.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env"
  );
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

async function testRandomQuestions() {
  const category: Category = "spicy"; // Test için bir kategori seç
  const count = 10; // Her seferinde kaç soru getirilecek
  const iterations = 5; // Kaç kere test edilecek

  console.log("🧪 Random Question Test");
  console.log("=".repeat(60));
  console.log(`Category: ${category}`);
  console.log(`Questions per call: ${count}`);
  console.log(`Number of iterations: ${iterations}`);
  console.log("=".repeat(60));
  console.log();

  const allResults: Array<{
    iteration: number;
    questionIds: string[];
    orderIndices: number[];
  }> = [];

  // 5 kere çağır
  for (let i = 1; i <= iterations; i++) {
    console.log(`\n📋 Iteration ${i}:`);
    console.log("-".repeat(60));

    try {
      const questions = await fetchRandomQuestions(
        category,
        count,
        supabaseAdmin
      );

      // Veritabanından order_index'leri almak için direkt sorgu yapalım
      const questionIds = questions.map((q) => q.id);
      const { data: dbQuestions, error } = await supabaseAdmin
        .from("questions")
        .select("id, order_index")
        .in("id", questionIds);

      if (error) {
        console.error("❌ Error fetching order_index:", error);
        continue;
      }

      // order_index'leri map'le
      const orderIndices = questions.map((q) => {
        const dbQ = dbQuestions?.find((dq) => dq.id === q.id);
        return dbQ?.order_index ?? -1;
      });

      // Sonuçları göster
      console.log(`   Questions received: ${questions.length}`);
      console.log(`   Question IDs: ${questionIds.join(", ")}`);
      console.log(`   Order Indices: ${orderIndices.join(", ")}`);
      console.log(
        `   Order Indices (sorted): ${[...orderIndices]
          .sort((a, b) => a - b)
          .join(", ")}`
      );

      allResults.push({
        iteration: i,
        questionIds,
        orderIndices,
      });

      // Kısa bir bekleme (random seed'in değişmesi için)
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`❌ Error in iteration ${i}:`, error);
    }
  }

  // Analiz
  console.log("\n\n📊 Analysis:");
  console.log("=".repeat(60));

  // Tüm unique question ID'leri
  const allUniqueIds = new Set<string>();
  allResults.forEach((result) => {
    result.questionIds.forEach((id) => allUniqueIds.add(id));
  });

  console.log(
    `Total unique questions across all iterations: ${allUniqueIds.size}`
  );
  console.log(
    `Total questions fetched: ${allResults.reduce(
      (sum, r) => sum + r.questionIds.length,
      0
    )}`
  );

  // Her iteration'da kaç farklı soru geldi
  console.log("\nUnique questions per iteration:");
  allResults.forEach((result) => {
    const unique = new Set(result.questionIds);
    console.log(
      `  Iteration ${result.iteration}: ${unique.size} unique questions`
    );
  });

  // Tekrar eden sorular var mı?
  const questionFrequency = new Map<string, number>();
  allResults.forEach((result) => {
    result.questionIds.forEach((id) => {
      questionFrequency.set(id, (questionFrequency.get(id) || 0) + 1);
    });
  });

  const repeatedQuestions = Array.from(questionFrequency.entries())
    .filter(([_, count]) => count > 1)
    .sort(([_, a], [__, b]) => b - a);

  if (repeatedQuestions.length > 0) {
    console.log("\n⚠️ Repeated questions (appeared in multiple iterations):");
    repeatedQuestions.forEach(([id, count]) => {
      console.log(`  Question ${id}: appeared ${count} times`);
    });
  } else {
    console.log("\n✅ No repeated questions across iterations");
  }

  // Order index dağılımı
  console.log("\nOrder Index Distribution:");
  const allOrderIndices = allResults.flatMap((r) => r.orderIndices);
  const minOrder = Math.min(...allOrderIndices);
  const maxOrder = Math.max(...allOrderIndices);
  console.log(`  Min order_index: ${minOrder}`);
  console.log(`  Max order_index: ${maxOrder}`);
  console.log(`  Range: ${maxOrder - minOrder}`);

  // Her iteration'ın order_index'lerini göster
  console.log("\nOrder Indices per iteration:");
  allResults.forEach((result) => {
    const sorted = [...result.orderIndices].sort((a, b) => a - b);
    console.log(`  Iteration ${result.iteration}: [${sorted.join(", ")}]`);
  });

  // Randomizasyon kalitesi kontrolü
  console.log("\n🎲 Randomization Quality:");
  const allOrderArrays = allResults.map((r) =>
    [...r.orderIndices].sort((a, b) => a - b)
  );
  const isSameOrder = allOrderArrays.every(
    (arr, i) =>
      i === 0 || JSON.stringify(arr) === JSON.stringify(allOrderArrays[0])
  );

  if (isSameOrder) {
    console.log(
      "  ⚠️ WARNING: All iterations returned questions in the same order!"
    );
    console.log(
      "     This suggests the randomization might not be working properly."
    );
  } else {
    console.log(
      "  ✅ Different orders detected - randomization appears to be working"
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ Test completed!");
}

// Testi çalıştır
testRandomQuestions().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
