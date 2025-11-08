import { createClient } from "@supabase/supabase-js";
import { Question, Category } from "../types.js";

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

/**
 * Fetch random questions from Supabase
 * @param category - Question category
 * @param count - Number of questions to fetch
 * @returns Array of questions
 */
export async function fetchRandomQuestions(
  category: Category,
  count: number
): Promise<Question[]> {
  try {
    const { data, error } = await supabase
      .from("questions")
      .select("*")
      .eq("category", category)
      .limit(count * 2); // Fetch more to ensure we have enough after random

    if (error) {
      console.error("Error fetching questions from Supabase:", error);
      throw new Error("Failed to fetch questions");
    }

    if (!data || data.length === 0) {
      console.error("No questions found for category:", category);
      throw new Error("No questions available");
    }

    // Shuffle and take requested count
    const shuffled = data.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, count);

    return selected.map((q) => ({
      id: q.id,
      text: q.text,
      category: q.category,
      haveAnswers: q.have_answers || false,
      answers: q.answers || [],
    }));
  } catch (error) {
    console.error("Error in fetchRandomQuestions:", error);
    throw error;
  }
}

/**
 * Mock questions for development/testing (when Supabase is not configured)
 */
export function getMockQuestions(
  category: Category,
  count: number
): Question[] {
  const mockQuestions: Question[] = [
    // just-friends (5 questions)
    {
      id: 1,
      text: "Do you like coffee?",
      category: "just-friends",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 2,
      text: "Would you go skydiving?",
      category: "just-friends",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 3,
      text: "Do you like spicy food?",
      category: "just-friends",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 11,
      text: "Are you an introvert?",
      category: "just-friends",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 12,
      text: "Do you enjoy horror movies?",
      category: "just-friends",
      haveAnswers: false,
      answers: [],
    },
    // we_just_met (5 questions)
    {
      id: 4,
      text: "Are you a morning person?",
      category: "we_just_met",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 5,
      text: "Do you prefer beach or mountains?",
      category: "we_just_met",
      haveAnswers: true,
      answers: ["Beach", "Mountains"],
    },
    {
      id: 13,
      text: "Do you like animals?",
      category: "we_just_met",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 14,
      text: "Are you a vegetarian?",
      category: "we_just_met",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 15,
      text: "Do you like to travel?",
      category: "we_just_met",
      haveAnswers: false,
      answers: [],
    },
    // long_term (5 questions)
    {
      id: 6,
      text: "Have you ever been in love?",
      category: "long_term",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 7,
      text: "Would you relocate for love?",
      category: "long_term",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 16,
      text: "Do you want kids in the future?",
      category: "long_term",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 17,
      text: "Do you believe in marriage?",
      category: "long_term",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 18,
      text: "Would you share your finances with your partner?",
      category: "long_term",
      haveAnswers: false,
      answers: [],
    },
    // spicy (5 questions)
    {
      id: 8,
      text: "Have you ever cheated?",
      category: "spicy",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 9,
      text: "Would you date someone 10 years older?",
      category: "spicy",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 10,
      text: "Do you believe in love at first sight?",
      category: "spicy",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 19,
      text: "Have you ever had a one night stand?",
      category: "spicy",
      haveAnswers: false,
      answers: [],
    },
    {
      id: 20,
      text: "Would you forgive cheating?",
      category: "spicy",
      haveAnswers: false,
      answers: [],
    },
  ];

  // Filter by category and shuffle
  const filtered = mockQuestions.filter((q) => q.category === category);
  const shuffled = filtered.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}
