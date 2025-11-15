import { Question, Category } from "../types.js";

/**
 * Fetch random questions from Supabase using RPC function
 * Randomization is done at database level using PostgreSQL's RANDOM() function
 * @param category - Question category (category_id in database)
 * @param count - Number of questions to fetch (default: 10)
 * @param supabaseAdmin - Supabase admin client (with service role key)
 * @returns Array of questions
 */
export async function fetchRandomQuestions(
  category: Category,
  count: number,
  supabaseAdmin: any
): Promise<Question[]> {
  if (!supabaseAdmin) {
    throw new Error("Supabase admin client is required");
  }

  try {
    // Call Supabase RPC function to get random questions
    // The function is defined in Supabase database (see SQL migration)
    const { data, error } = await supabaseAdmin.rpc("get_random_questions", {
      p_category_id: category,
      p_count: count,
    });

    if (error) {
      console.error("Error fetching questions from Supabase RPC:", error);
      throw new Error("Failed to fetch questions");
    }

    if (!data || data.length === 0) {
      console.error("No questions found for category:", category);
      throw new Error("No questions available");
    }

    if (data.length < count) {
      console.warn(
        `⚠️ Only found ${data.length} questions in category, requested ${count}`
      );
    }

    // Map database results to Question interface
    return data.map((q: any) => {
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

      // Handle answers: multi-language object or null
      let answers: Question["answers"] = null;

      if (
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
        haveAnswers: q.have_answers || false,
        answers: answers,
      };
    });
  } catch (error) {
    console.error("Error in fetchRandomQuestions:", error);
    throw error;
  }
}
