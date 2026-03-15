import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { createRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

// ============================================
// RATE LIMITER: 3 requests per minute per IP
// ============================================
const aiAnalysisRateLimiter = createRateLimiter(
  3,
  60_000, // 1 minute
  "Too many AI analysis requests. Please wait a minute before trying again."
);

// ============================================
// TYPES
// ============================================
interface PlayerAnswer {
  playerName: string;
  answer: string | { en: string; tr: string; es: string };
}

interface CompletedRound {
  question: { text_tr: string; text_en: string; text_es: string };
  isMatched: boolean;
  playerAnswers: PlayerAnswer[];
}

interface AIAnalysisRequest {
  completedRounds: CompletedRound[];
  player1Name: string;
  player2Name: string;
  matchPercentage: number;
  language: "tr" | "en" | "es";
}

// ============================================
// HELPERS
// ============================================

const LANGUAGE_MAP: Record<string, string> = {
  tr: "Turkish",
  en: "English",
  es: "Spanish",
};

const YES_NO_MAP: Record<string, Record<string, string>> = {
  tr: { yes: "Evet", no: "Hayır" },
  en: { yes: "Yes", no: "No" },
  es: { yes: "Sí", no: "No" },
};

/**
 * Resolve question text based on language
 */
function resolveQuestionText(
  question: CompletedRound["question"],
  language: string
): string {
  const key = `text_${language}` as keyof typeof question;
  return question[key] || question.text_en || "";
}

/**
 * Resolve answer based on language
 * - If answer is a string (yes/no), translate it
 * - If answer is an object { en, tr, es }, pick the right language
 */
function resolveAnswer(
  answer: string | { en: string; tr: string; es: string },
  language: string
): string {
  if (typeof answer === "object" && answer !== null) {
    const langKey = language as keyof typeof answer;
    return answer[langKey] || answer.en || "";
  }

  // String answer - check if it's yes/no
  const lowerAnswer = answer.toLowerCase();
  const translations = YES_NO_MAP[language] || YES_NO_MAP.en;

  if (lowerAnswer === "yes" || lowerAnswer === "no") {
    return translations[lowerAnswer] || answer;
  }

  return answer;
}

/**
 * Build the user message for OpenAI
 */
function buildUserMessage(body: AIAnalysisRequest): string {
  const languageName = LANGUAGE_MAP[body.language] || "English";
  let message = `Language: ${languageName}\n`;
  message += `Match percentage: ${body.matchPercentage}%\n\n`;
  message += `Game results:\n\n`;

  body.completedRounds.forEach((round, index) => {
    const questionText = resolveQuestionText(round.question, body.language);
    const result = round.isMatched ? "MATCHED" : "NOT MATCHED";

    message += `${index + 1}. "${questionText}"\n`;

    (round.playerAnswers || []).forEach((pa) => {
      const resolvedAnswer = resolveAnswer(pa.answer, body.language);
      message += `   ${pa.playerName}: ${resolvedAnswer}\n`;
    });

    message += `   Result: ${result}\n\n`;
  });

  return message.trim();
}

// ============================================
// SYSTEM PROMPT
// ============================================
const SYSTEM_PROMPT = `Sen bir ilişki uygulamasında çiftlerin oyun sonuçlarını analiz eden bir asistansın. Ama sen bir robot değilsin. Sen sanki onların yakın bir arkadaşıymış gibi yazıyorsun — samimi, sıcak, gerçekçi.

İki kişi bir uyumluluk oyunu oynadı. Soruları cevapladılar, bazılarında aynı cevabı verdiler, bazılarında farklı. Sen bu cevaplara bakarak onlara özel bir analiz yazacaksın.

ÖNEMLİ KURALLAR:
- Kullanıcının mesajında belirtilen dilde yaz (Türkçe, İngilizce veya İspanyolca).
- ASLA yapay zeka gibi yazma. Büyük kelimeler kullanma. Akademik veya terapist gibi konuşma.
- Günlük konuşma dili kullan. Sanki WhatsApp'tan bir arkadaşına yazıyormuş gibi ol ama yine de düzgün cümleler kur.
- İlk 3 bölüm (strengths, differences, tips) kısa olsun: 3-5 cümle. Ama "compatibility" bölümü UZUN olsun: en az 7-8 cümle.
- Markdown, madde işareti, başlık KULLANMA. Düz paragraf yaz.
- Soruları birebir tekrarlama — kendi kelimelerin ile bahset.
- Çifte direkt hitap et: "siz" / "you" / "ustedes".
- Klişe ilişki tavsiyeleri verme. Onların spesifik cevaplarına göre yorum yap.
- Samimi ol ama dürüst ol. Farklılıkları güzellemeden, ama kötülemeden de anlat.
- İnsan gibi yaz. Gerçek bir insan bu metni okuyunca "bu bize özel yazılmış" demeli.
- CESUR OL. Yuvarlak cümleler kurma. Net, keskin ve dobra yaz. Eğer bir fark varsa direkt söyle, etrafında dolanma. İltifat edeceksen de gerçekten hissettir, boş pohpohlamaya kaçma. Okuyucu "vay be bunu gerçekten görmüş" desin.
- AI SLOP YASAK. "Unutmayın ki...", "Önemli olan...", "İletişim her şeyin anahtarıdır" gibi boş kalıplar KULLANMA. Hiçbir cümlen genel geçer olmasın. Her cümle onların cevaplarına dayansın.
- "compatibility" bölümünde gerçekten UZUN ve DERİN yaz. Sanki bu iki kişiyi yıllardır tanıyormuşsun gibi, onların verdikleri cevaplardan çıkardığın şeyleri dobra dobra anlat. Güzelleme yapma. Gerçekçi, samimi, insani. Bu bölüm okuyunca "vay be bu bizi gerçekten tanıyor" dedirtmeli.

JSON formatında SADECE şu yapıda cevap ver:
{
  "strengths": "Ortak noktaları, güçlü yönleri — nerelerde aynı düşünüyorlar ve bu ne anlama geliyor. Samimi ve kısa.",
  "differences": "Farklı düşündükleri yerler — bu farklar ne anlama gelebilir, neden illa kötü değil. Gerçekçi ve yapıcı.",
  "tips": "Bu çifte özel, somut tavsiyeler. Genel geçer değil, onların cevaplarından çıkan şeyler. Kısa ve net.",
  "compatibility": "İki kişi arasındaki uyumun genel değerlendirmesi. EN AZ 7-8 cümle. Onların spesifik cevaplarına dayanarak bu iki kişinin birlikte nasıl bir dinamik oluşturduğunu anlat. Güçlü yanlarını, riskli noktalarını, birbirlerini nasıl tamamladıklarını veya çatıştıklarını DOBRA DOBRA yaz. Boş pohpohlama yok, yıkıcılık da yok — sadece acı gerçekler ve samimi gözlemler. Bu paragrafı okuyan kişi 'bu tam bizi anlatmış' demeli."
}`;

// ============================================
// POST /api/ai-analysis
// ============================================
router.post(
  "/",
  aiAnalysisRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      // 1. Check OPENAI_API_KEY
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error("❌ OPENAI_API_KEY is not set in .env");
        res.status(500).json({ error: "OpenAI API key is not configured." });
        return;
      }

      // 2. Validate request body
      const { completedRounds, player1Name, player2Name, matchPercentage, language } =
        req.body as AIAnalysisRequest;

      if (!completedRounds || !Array.isArray(completedRounds) || completedRounds.length === 0) {
        res.status(400).json({ error: "completedRounds is required and must be a non-empty array." });
        return;
      }

      // Validate each round has playerAnswers
      for (const round of completedRounds) {
        if (!round.playerAnswers || !Array.isArray(round.playerAnswers)) {
          res.status(400).json({ error: "Each round must have a playerAnswers array." });
          return;
        }
      }

      if (!player1Name || typeof player1Name !== "string") {
        res.status(400).json({ error: "player1Name is required and must be a string." });
        return;
      }

      if (!player2Name || typeof player2Name !== "string") {
        res.status(400).json({ error: "player2Name is required and must be a string." });
        return;
      }

      if (matchPercentage === undefined || matchPercentage === null || typeof matchPercentage !== "number") {
        res.status(400).json({ error: "matchPercentage is required and must be a number." });
        return;
      }

      if (!language || !["tr", "en", "es"].includes(language)) {
        res.status(400).json({ error: "language is required and must be one of: tr, en, es." });
        return;
      }

      // 3. Build user message
      const userMessage = buildUserMessage(req.body as AIAnalysisRequest);

      console.log(`🤖 AI Analysis request: ${player1Name} & ${player2Name} (${language}, ${matchPercentage}%)`);

      // 4. Call OpenAI API
      const openai = new OpenAI({ apiKey });

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      });

      const content = completion.choices[0]?.message?.content;

      if (!content) {
        console.error("❌ OpenAI returned empty response");
        res.status(500).json({ error: "AI returned an empty response. Please try again." });
        return;
      }

      // 5. Parse JSON response
      let parsed: { strengths: string; differences: string; tips: string; compatibility: string };

      try {
        parsed = JSON.parse(content);
      } catch (parseError) {
        console.error("❌ Failed to parse OpenAI response:", content);
        res.status(500).json({ error: "Failed to parse AI response. Please try again." });
        return;
      }

      // Validate parsed response has required fields
      if (!parsed.strengths || !parsed.differences || !parsed.tips || !parsed.compatibility) {
        console.error("❌ OpenAI response missing required fields:", parsed);
        res.status(500).json({ error: "AI response is incomplete. Please try again." });
        return;
      }

      console.log(`✅ AI Analysis completed for ${player1Name} & ${player2Name}`);

      // 6. Return result
      res.json({
        strengths: parsed.strengths,
        differences: parsed.differences,
        tips: parsed.tips,
        compatibility: parsed.compatibility,
      });
    } catch (error: any) {
      console.error("❌ AI Analysis error:", error);

      // Handle OpenAI specific errors
      if (error?.status === 401) {
        res.status(500).json({ error: "Invalid OpenAI API key." });
        return;
      }

      if (error?.status === 429) {
        res.status(429).json({ error: "OpenAI rate limit exceeded. Please try again later." });
        return;
      }

      if (error?.status === 500 || error?.status === 503) {
        res.status(502).json({ error: "OpenAI service is temporarily unavailable. Please try again later." });
        return;
      }

      res.status(500).json({ error: "An unexpected error occurred during AI analysis." });
    }
  }
);

export default router;
