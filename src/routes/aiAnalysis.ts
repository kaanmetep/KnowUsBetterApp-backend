import { Router, Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { byAppUserId, createRateLimiter } from "../middleware/rateLimiter.js";
import { creditCoins, spendCoins } from "../services/coinLedger.js";
import {
  FINISHED_GAME_TTL_SECONDS,
  FinishedGame,
  getFinishedGame,
  getLastFinishedGameOf,
} from "../services/finishedGames.js";
import { allowLegacyClients, requireAppUser } from "../services/appUserAuth.js";
import { PUBLIC_RUNTIME_CONFIG } from "../services/publicConfigService.js";
import {
  HIDDEN_TEXT_ANSWER,
  TEXT_ANSWER_MAX_LENGTH,
} from "../utils/helpers.js";
import { acquireLock, redis, releaseLock } from "../utils/redis.js";

// ============================================
// RATE LIMITERS
// ============================================
// Per IP. Each recorded game can only be analysed a few times before the
// cache answers, so this only has to stop scripted floods.
const aiAnalysisRateLimiter = createRateLimiter(
  10,
  60_000, // 1 minute
  "Too many AI analysis requests. Please wait a minute before trying again.",
);

// Per player: retries of a paid analysis are served from the cache.
const gameAnalysisRateLimiter = createRateLimiter(
  6,
  60_000,
  "Too many AI analysis requests. Please wait a minute before trying again.",
  byAppUserId((req) => req.body?.appUserId),
);

// Both attempts together must finish before iOS gives up on the request (60s),
// or the app shows an error for an analysis that was charged and delivered.
const OPENAI_TIMEOUT_MS = 25_000;
const OPENAI_MAX_RETRIES = 1;
const ANALYSIS_LOCK_SECONDS = 120;

// ============================================
// TYPES
// ============================================
interface PlayerAnswer {
  playerName: string;
  answer: string | { en: string; tr: string; es: string };
}

interface CompletedRound {
  question: {
    text_tr: string;
    text_en: string;
    text_es: string;
    questionType?: "choice" | "text";
  };
  isMatched: boolean;
  isScored?: boolean;
  playerAnswers: PlayerAnswer[];
}

interface AIAnalysisRequest {
  completedRounds: CompletedRound[];
  player1Name: string;
  player2Name: string;
  matchPercentage: number;
  language: "tr" | "en" | "es";
  analysisType?: "default" | "know_me_well";
  player1AboutPlayer2Percentage?: number;
  player2AboutPlayer1Percentage?: number;
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
  language: string,
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
  language: string,
): string {
  if (answer === null || answer === undefined) return "";
  if (typeof answer === "object") {
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

const OPEN_ANSWER_MAX_LENGTH = TEXT_ANSWER_MAX_LENGTH;

const NO_ANSWER_MAP: Record<string, string> = {
  tr: "(boş bıraktı)",
  en: "(left blank)",
  es: "(lo dejó en blanco)",
};

const HIDDEN_ANSWER_MAP: Record<string, string> = {
  tr: "(cevap gizlendi)",
  en: "(answer hidden)",
  es: "(respuesta oculta)",
};

function isOpenRound(round: CompletedRound): boolean {
  return round.isScored === false;
}

function isTypedRound(round: CompletedRound): boolean {
  return round.question?.questionType === "text";
}

/** Typed answers are user input: kept on one line, capped and quoted. */
function resolveOpenAnswer(answer: unknown, language: string): string {
  if (answer === HIDDEN_TEXT_ANSWER) {
    return HIDDEN_ANSWER_MAP[language] || HIDDEN_ANSWER_MAP.en;
  }
  const text =
    typeof answer === "string"
      ? Array.from(answer.replace(/\s+/g, " ").trim())
          .slice(0, OPEN_ANSWER_MAX_LENGTH)
          .join("")
          .replace(/"/g, "'")
      : "";
  return text ? `"${text}"` : NO_ANSWER_MAP[language] || NO_ANSWER_MAP.en;
}

/**
 * Build the user message for OpenAI
 */
function buildUserMessage(
  body: AIAnalysisRequest,
  analysisMode: "default" | "know_me_well",
): string {
  const languageName = LANGUAGE_MAP[body.language] || "English";
  let message = `Language: ${languageName}\n`;
  message += `Match percentage: ${body.matchPercentage}%\n\n`;

  if (analysisMode === "know_me_well") {
    message += `${body.player1Name} about ${body.player2Name}: ${body.player1AboutPlayer2Percentage}%\n`;
    message += `${body.player2Name} about ${body.player1Name}: ${body.player2AboutPlayer1Percentage}%\n\n`;
  }

  if (body.completedRounds.some(isTypedRound)) {
    message +=
      `Note: answers in quotes were typed freely by the players; their ` +
      `result was judged by meaning, not exact wording.\n`;
  }
  if (body.completedRounds.some(isOpenRound)) {
    message +=
      `Note: rounds marked OPEN ANSWER are not counted in the percentages ` +
      `above; compare the meaning of the two answers yourself and use them ` +
      `as extra insight.\n`;
  }
  message += `\n`;

  message += `Game results:\n\n`;

  body.completedRounds.forEach((round, index) => {
    const questionText = resolveQuestionText(round.question, body.language);
    const open = isOpenRound(round);
    const typed = isTypedRound(round) || open;
    const result = open
      ? "OPEN ANSWER"
      : round.isMatched
        ? "MATCHED"
        : "NOT MATCHED";

    message += `${index + 1}. "${questionText}"\n`;

    (round.playerAnswers || []).forEach((pa) => {
      const resolvedAnswer = typed
        ? resolveOpenAnswer(pa.answer, body.language)
        : resolveAnswer(pa.answer, body.language);
      message += `   ${pa.playerName}: ${resolvedAnswer}\n`;
    });

    message += `   Result: ${result}\n\n`;
  });

  return message.trim();
}

// ============================================
// SYSTEM PROMPT
// ============================================
const DEFAULT_SYSTEM_PROMPT = `Sen bir ilişki uygulamasında çiftlerin oyun sonuçlarını analiz eden bir asistansın. Ama sen bir robot değilsin. Sen sanki onların yakın bir arkadaşıymış gibi yazıyorsun — samimi, sıcak, gerçekçi.

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

const KNOW_ME_WELL_SYSTEM_PROMPT = `Sen bir ilişki uygulamasında çiftlerin birbirlerini ne kadar tanıdığını analiz eden, onların en yakın arkadaşı tadında bir asistansın. Robot değilsin; samimi, sıcak, bazen hafif iğneleyici ama her zaman gerçekçi bir dil kullanıyorsun. Girdi olarak sana iki adet yüzde gelecek: player1'in player2'yi bilme oranı ve player2'nin player1'i bilme oranı.

Sistem şu şekilde işliyor: Çiftler karşılıklı 10 soru cevapladı. Bu yüzdelere bakarak iki ayrı analiz yazacaksın.

KURALLARIN:
1. TONLAMA: Asla agresifleşme, kimseye kızma veya aşağılayıcı bir tona girme. Eğer bir taraf diğerini bilemediyse, bunu cidden mi bunu nasıl kaçırdın gibi şaşkın veya mizahi bir tonda, aranızdaki şakacı bir arkadaşlığın verdiği rahatlıkla dile getir.
2. YÜZDE MANTIĞI: Eğer skor 100 ise, kesinlikle iğneleyici veya kusur arayıcı bir tona girme. Bu durumda sadece aralarındaki muazzam uyumu ve birbirlerini nasıl bu kadar iyi tanıdıklarını öven, ilişkinin ne kadar sağlam olduğunu vurgulayan harika cümleler kur. Eğer skor 100'ün altındaysa, aradaki küçük kopukluklara, dikkat edilmeyen detaylara veya gözden kaçanlara şakacı ve samimi bir dille, bir dostun gözlem yapması gibi değin.
3. SORULARI TEKRARLAMA: Hangi soruya ne cevap verdiklerini hatırlatmaya çalışma. Soru listeleme, şunu dedin deme. Sonucu, yani aralarındaki durumun fotoğrafını dedikodu yapar gibi anlat.
4. FORMAT: Asla Markdown (kalın, italik, liste) kullanma. Sadece düz paragraf yaz. Emoji kullanma.
5. UZUNLUK: Her bir analiz en az 7-8 cümle olsun. İyice göm ya da tebrik et ama boş konuşma. Sadece durumu analiz et.

JSON formatında SADECE şu yapıda cevap ver:
{
"player1AboutPlayer2": "Player 1'in, Player 2 hakkındaki tahminlerini değerlendiren, yukarıdaki kurallara uygun, samimi paragraf.",
"player2AboutPlayer1": "Player 2'nin, Player 1 hakkındaki tahminlerini değerlendiren, yukarıdaki kurallara uygun, samimi paragraf."
}`;

// ============================================
// OPENAI CALL
// ============================================
type DefaultAnalysis = {
  strengths: string;
  differences: string;
  tips: string;
  compatibility: string;
};
type KnowMeWellAnalysis = {
  player1AboutPlayer2: string;
  player2AboutPlayer1: string;
};

class AnalysisError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isFilled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

async function runAnalysis(
  body: AIAnalysisRequest,
  analysisMode: "default" | "know_me_well",
): Promise<DefaultAnalysis | KnowMeWellAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("❌ OPENAI_API_KEY is not set in .env");
    throw new AnalysisError(500, "OpenAI API key is not configured.");
  }

  const openai = new OpenAI({
    apiKey,
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
  });
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    max_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          analysisMode === "know_me_well"
            ? KNOW_ME_WELL_SYSTEM_PROMPT
            : DEFAULT_SYSTEM_PROMPT,
      },
      { role: "user", content: buildUserMessage(body, analysisMode) },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    console.error("❌ OpenAI returned empty response");
    throw new AnalysisError(500, "AI returned an empty response. Please try again.");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.error("❌ Failed to parse OpenAI response:", content);
    throw new AnalysisError(500, "Failed to parse AI response. Please try again.");
  }

  if (analysisMode === "know_me_well") {
    if (!isFilled(parsed.player1AboutPlayer2) || !isFilled(parsed.player2AboutPlayer1)) {
      console.error("❌ OpenAI response missing required fields (know_me_well):", parsed);
      throw new AnalysisError(500, "AI response is incomplete. Please try again.");
    }
    console.log(`✅ AI Analysis completed for ${body.player1Name} & ${body.player2Name}`);
    return {
      player1AboutPlayer2: parsed.player1AboutPlayer2,
      player2AboutPlayer1: parsed.player2AboutPlayer1,
    };
  }

  if (
    !isFilled(parsed.strengths) ||
    !isFilled(parsed.differences) ||
    !isFilled(parsed.tips) ||
    !isFilled(parsed.compatibility)
  ) {
    console.error("❌ OpenAI response missing required fields (default):", parsed);
    throw new AnalysisError(500, "AI response is incomplete. Please try again.");
  }
  console.log(`✅ AI Analysis completed for ${body.player1Name} & ${body.player2Name}`);
  return {
    strengths: parsed.strengths,
    differences: parsed.differences,
    tips: parsed.tips,
    compatibility: parsed.compatibility,
  };
}

function sendAnalysisError(res: Response, error: any): void {
  console.error("❌ AI Analysis error:", error);
  if (error instanceof AnalysisError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error?.status === 401) {
    res.status(500).json({ error: "Invalid OpenAI API key." });
    return;
  }
  if (error?.status === 429) {
    res.status(429).json({
      error: "OpenAI rate limit exceeded. Please try again later.",
    });
    return;
  }
  if (error?.status === 500 || error?.status === 503) {
    res.status(502).json({
      error: "OpenAI service is temporarily unavailable. Please try again later.",
    });
    return;
  }
  res
    .status(500)
    .json({ error: "An unexpected error occurred during AI analysis." });
}

/** Express 4 ignores a rejected handler, which would leave the request hanging. */
const catchErrors =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response): void => {
    handler(req, res).catch((error) => {
      if (res.headersSent) console.error("❌ AI Analysis error:", error);
      else sendAnalysisError(res, error);
    });
  };

/** The analysis request for one player of a finished game: they are player 1. */
function buildGameRequest(
  game: FinishedGame,
  myId: string,
  partnerId: string,
  language: AIAnalysisRequest["language"],
  analysisMode: AnalysisMode = analysisModeOf(game),
): AIAnalysisRequest {
  const nameOf = (id: string) => game.players.find((p) => p.id === id)?.name ?? "";
  const percentOf = (id: string) =>
    game.summary.players?.find((p) => p.playerId === id)?.percent ?? 0;
  return {
    completedRounds: game.completedRounds as unknown as CompletedRound[],
    player1Name: nameOf(myId),
    player2Name: nameOf(partnerId),
    matchPercentage: game.percentage,
    language,
    analysisType: analysisMode,
    ...(analysisMode === "know_me_well" && {
      player1AboutPlayer2Percentage: percentOf(myId),
      player2AboutPlayer1Percentage: percentOf(partnerId),
    }),
  };
}

type AnalysisMode = "default" | "know_me_well";

const analysisModeOf = (game: FinishedGame): AnalysisMode =>
  game.mode === "know_each_other" ? "know_me_well" : "default";

const isLanguage = (value: unknown): value is AIAnalysisRequest["language"] =>
  value === "tr" || value === "en" || value === "es";

/**
 * Older builds send back the rounds they got in game-finished instead of a
 * gameId; the game is found again from the socket ids and question ids in
 * them, so only a game the server actually ran can be analysed.
 */
async function findGameFromRounds(rounds: unknown[]): Promise<FinishedGame | null> {
  const questionIds = rounds.map((round: any) => round?.question?.id);
  if (questionIds.some((id) => typeof id !== "string")) return null;

  const playerIds = new Set<string>();
  for (const round of rounds as any[]) {
    if (!Array.isArray(round?.playerAnswers)) continue;
    for (const answer of round.playerAnswers) {
      if (typeof answer?.playerId === "string") playerIds.add(answer.playerId);
    }
  }

  for (const playerId of [...playerIds].slice(0, 2)) {
    const game = await getLastFinishedGameOf(playerId);
    if (
      game &&
      game.completedRounds.length === questionIds.length &&
      game.completedRounds.every((round, i) => round.question.id === questionIds[i])
    ) {
      return game;
    }
  }
  return null;
}

export function createAiAnalysisRouter({
  supabaseAdmin,
  onBalanceChanged,
}: {
  supabaseAdmin: SupabaseClient | null;
  /** Lets the app update its wallet as soon as coins move. */
  onBalanceChanged: (appUserId: string, newBalance: number) => void;
}): Router {
  const router = Router();

  // ============================================
  // POST /api/ai-analysis
  // Kept for app builds that send the game themselves and spend the coins
  // over the socket afterwards. Only the game the server recorded is
  // analysed, once per player and language, whatever else the body says.
  // ============================================
  router.post(
    "/",
    aiAnalysisRateLimiter,
    catchErrors(async (req: Request, res: Response): Promise<void> => {
      if (!allowLegacyClients()) {
        res.status(410).json({
          error: "Please update the app to use AI analysis.",
          code: "UPDATE_REQUIRED",
        });
        return;
      }
      if (!supabaseAdmin) {
        res.status(500).json({ error: "Database not configured." });
        return;
      }
      if (!PUBLIC_RUNTIME_CONFIG.economy.aiAnalysis.enabled) {
        res.status(403).json({ error: "AI analysis is turned off.", code: "AI_DISABLED" });
        return;
      }

      const { completedRounds, player1Name, language, analysisType } = req.body ?? {};
      if (
        !Array.isArray(completedRounds) ||
        completedRounds.length === 0 ||
        typeof player1Name !== "string" ||
        !isLanguage(language)
      ) {
        res.status(400).json({ error: "Invalid AI analysis request." });
        return;
      }

      const game = await findGameFromRounds(completedRounds).catch(() => null);
      // player1Name is the requesting player in these builds.
      const me = game?.players.find((p) => p.name === player1Name);
      const partner = game?.players.find((p) => p !== me);
      if (!game || !me || !partner) {
        res.status(404).json({
          error: "This game is no longer available for analysis.",
          code: "GAME_NOT_FOUND",
        });
        return;
      }
      if (game.mode === "who_knows_better") {
        res.status(400).json({
          error: "AI analysis isn't available for this game.",
          code: "NOT_SUPPORTED",
        });
        return;
      }

      // These builds pick the response shape themselves.
      const analysisMode: AnalysisMode =
        analysisType === "know_me_well" ? "know_me_well" : "default";
      const cacheKey = `aiResult:legacy:${game.gameId}:${me.id}:${language}:${analysisMode}`;
      const cachedResult = await redis.get(cacheKey).catch(() => null);
      if (cachedResult) {
        res.json(JSON.parse(cachedResult));
        return;
      }

      const lockKey = `lock:ai:legacy:${game.gameId}:${me.id}`;
      if (!(await acquireLock(lockKey, ANALYSIS_LOCK_SECONDS))) {
        res.status(409).json({
          error: "Your analysis is already being prepared.",
          code: "IN_PROGRESS",
        });
        return;
      }
      try {
        console.log(
          `🤖 Legacy AI Analysis for game ${game.gameId} (${language}, ${analysisMode})`,
        );
        const result = await runAnalysis(
          buildGameRequest(game, me.id, partner.id, language, analysisMode),
          analysisMode,
        );
        await redis
          .setex(cacheKey, FINISHED_GAME_TTL_SECONDS, JSON.stringify(result))
          .catch((error) => console.warn("⚠️ Failed to cache AI analysis:", error));
        res.json(result);
      } catch (error) {
        sendAnalysisError(res, error);
      } finally {
        await releaseLock(lockKey);
      }
    }),
  );

  // ============================================
  // POST /api/ai-analysis/game
  // The game comes from the server's own record of it (see finishedGames),
  // and the coins are charged here; refunded if the analysis fails.
  // ============================================
  router.post(
    "/game",
    gameAnalysisRateLimiter,
    requireAppUser(supabaseAdmin, (req) => req.body?.appUserId),
    catchErrors(async (req: Request, res: Response): Promise<void> => {
      const { gameId, playerId, appUserId, language } = req.body ?? {};

      if (
        typeof gameId !== "string" ||
        typeof playerId !== "string" ||
        typeof appUserId !== "string" ||
        !gameId ||
        !playerId ||
        !appUserId.trim()
      ) {
        res.status(400).json({
          error: "gameId, playerId and appUserId are required.",
          code: "INVALID_REQUEST",
        });
        return;
      }
      if (!["tr", "en", "es"].includes(language)) {
        res.status(400).json({
          error: "language must be one of: tr, en, es.",
          code: "INVALID_REQUEST",
        });
        return;
      }
      if (!supabaseAdmin) {
        res.status(500).json({ error: "Database not configured." });
        return;
      }

      const { enabled, coinCost: cost } = PUBLIC_RUNTIME_CONFIG.economy.aiAnalysis;
      if (!enabled) {
        res
          .status(403)
          .json({ error: "AI analysis is turned off.", code: "AI_DISABLED" });
        return;
      }

      const game = await getFinishedGame(gameId);
      const me = game?.players.find((p) => p.id === playerId);
      const partner = game?.players.find((p) => p.id !== playerId);
      if (!game || !me || !partner) {
        res.status(404).json({
          error: "This game is no longer available for analysis.",
          code: "GAME_NOT_FOUND",
        });
        return;
      }
      if (game.mode === "who_knows_better") {
        res.status(400).json({
          error: "AI analysis isn't available for this game.",
          code: "NOT_SUPPORTED",
        });
        return;
      }

      const cacheKey = `aiResult:${gameId}:${playerId}:${language}`;
      const cachedResult = await redis.get(cacheKey).catch(() => null);
      if (cachedResult) {
        res.json(JSON.parse(cachedResult));
        return;
      }

      const lockKey = `lock:ai:${gameId}:${playerId}`;
      if (!(await acquireLock(lockKey, ANALYSIS_LOCK_SECONDS))) {
        res.status(409).json({
          error: "Your analysis is already being prepared.",
          code: "IN_PROGRESS",
        });
        return;
      }

      let charged = false;
      try {
        let newBalance: number | undefined;
        if (cost > 0) {
          const spend = await spendCoins(
            supabaseAdmin,
            appUserId,
            cost,
            "ai_analysis",
          );
          if (!spend.ok) {
            if (spend.reason === "insufficient") {
              res.status(402).json({
                error: "Not enough coins.",
                code: "INSUFFICIENT_COINS",
                required: cost,
                balance: spend.balance,
              });
            } else {
              res.status(500).json({ error: "Failed to charge coins." });
            }
            return;
          }
          charged = true;
          newBalance = spend.newBalance;
          onBalanceChanged(appUserId, spend.newBalance);
        }

        const analysisMode =
          game.mode === "know_each_other" ? "know_me_well" : "default";
        console.log(
          `🤖 AI Analysis for game ${gameId} (${language}, ${game.percentage}%, ${analysisMode})`,
        );
        const result = await runAnalysis(
          buildGameRequest(game, me.id, partner.id, language),
          analysisMode,
        );

        await redis
          .setex(cacheKey, FINISHED_GAME_TTL_SECONDS, JSON.stringify(result))
          .catch((error) =>
            console.warn("⚠️ Failed to cache AI analysis:", error),
          );
        res.json({ ...result, newBalance });
      } catch (error) {
        if (charged) {
          const refund = await creditCoins(
            supabaseAdmin,
            appUserId,
            cost,
            "refund",
          );
          if (refund.ok) onBalanceChanged(appUserId, refund.newBalance);
          else console.error(`❌ AI analysis refund failed for ${appUserId}`);
        }
        sendAnalysisError(res, error);
      } finally {
        await releaseLock(lockKey);
      }
    }),
  );

  return router;
}
