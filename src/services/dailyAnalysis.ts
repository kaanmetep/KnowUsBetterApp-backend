import { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { LANGS, isLang, type Lang } from "../languages.js";
import type { DailyTopic } from "../types.js";
import {
  LANGUAGE_MAP,
  type PromptRound,
  isOpenRound,
  isTypedRound,
  resolveAnswer,
  resolveOpenAnswer,
  resolveQuestionText,
} from "../utils/analysisText.js";
import { CategoryRecord, getCategoryCatalog } from "./categoryService.js";
import type { FinishedGame } from "./finishedGames.js";
import { sendLocalizedPush } from "./notificationService.js";
import { supabaseTokenStore } from "./pushTokenService.js";

/**
 * Daily analysis: once every 24 hours a player can play a short game on a
 * topic and get a detailed AI report about the two of them, kept for good.
 *
 * - The listed category `daily_analysis` is what rooms are created with; its
 *   coins_required is the price, paid by the host when the game starts.
 * - Topics are the other (unlisted) categories of the `daily_analysis`
 *   group; the game asks their questions. Each analysis is a "chapter": the
 *   host gets the topic they have done the fewest times, in order_index order.
 * - Starting a game takes the 24 hours of every player in it (one analysis
 *   per person per day); a game that doesn't finish gives them back.
 */

export const DAILY_ANALYSIS_CATEGORY_ID = "daily_analysis";
const TOPIC_GROUP_ID = "daily_analysis";
export const DAILY_ANALYSIS_QUESTION_COUNT = 8;
export const DAILY_ANALYSIS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A streak survives a late day: the next analysis has to start within this. */
const STREAK_GAP_MS = 48 * 60 * 60 * 1000;
/** A game takes minutes; a row still "playing" after this was left behind by a restart. */
const ABANDONED_GAME_MS = 60 * 60 * 1000;
/** An analysis still running after this was cut off (e.g. by a restart). */
const STALLED_ANALYSIS_MS = 3 * 60 * 1000;
const PREVIOUS_CHAPTERS_IN_PROMPT = 3;

const OPENAI_TIMEOUT_MS = 60_000;
const OPENAI_MAX_RETRIES = 2;

const TABLE = "daily_analyses";

export type DailyAnalysisStatus = "playing" | "analyzing" | "ready" | "failed";

export interface DailyAnalysisReport {
  headline: string;
  summary: string;
  insights: { title: string; text: string }[];
  blindSpot: string;
  mission: { title: string; text: string };
  talkPrompt: string;
}

export interface DailyAnalysisPlayer {
  appUserId: string | null;
  name: string;
  avatar: string;
  isHost: boolean;
}

interface Row {
  id: string;
  host_app_user_id: string;
  participant_ids: string[];
  topic_id: string;
  chapter: number;
  language: string;
  status: DailyAnalysisStatus;
  players: DailyAnalysisPlayer[];
  rounds: PromptRound[] | null;
  percentage: number | null;
  report: DailyAnalysisReport | null;
  started_at: string;
  finished_at: string | null;
}

/** An analysis as a player's app shows it. */
export interface DailyAnalysisView {
  id: string;
  status: Exclude<DailyAnalysisStatus, "playing">;
  topic: { id: string; labels: Record<string, string> };
  chapter: number;
  createdAt: string;
  percentage: number | null;
  players: { name: string; avatar: string; isYou: boolean }[];
  report: DailyAnalysisReport | null;
  /** The report failed (or was cut off) and can be written again for free. */
  canRetry: boolean;
}

export interface DailyAnalysisSummary {
  id: string;
  status: Exclude<DailyAnalysisStatus, "playing">;
  topic: { id: string; labels: Record<string, string> };
  chapter: number;
  createdAt: string;
  percentage: number | null;
  headline: string | null;
  partner: { name: string; avatar: string } | null;
}

export interface DailyAnalysisStatusView {
  /** null when the player can start one now. */
  availableAt: string | null;
  /** The topic their next analysis would be about; null when none is set up. */
  next: DailyTopic | null;
  streak: number;
  total: number;
}

// ============================================
// TOPICS & STATUS
// ============================================

async function listTopics(supabase: SupabaseClient): Promise<CategoryRecord[]> {
  const { categories } = await getCategoryCatalog(supabase);
  return categories
    .filter(
      (category) =>
        category.groupId === TOPIC_GROUP_ID &&
        category.id !== DAILY_ANALYSIS_CATEGORY_ID,
    )
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

const topicOf = (topics: CategoryRecord[], id: string) => {
  const topic = topics.find((t) => t.id === id);
  return { id, labels: topic?.labels ?? {} };
};

/** Whether a row still holds its players' 24 hours. */
const holdsCooldown = (row: Pick<Row, "status" | "started_at">, now: number) =>
  row.status !== "playing" ||
  now - new Date(row.started_at).getTime() < ABANDONED_GAME_MS;

type HistoryRow = Pick<Row, "id" | "topic_id" | "status" | "started_at">;

async function historyOf(
  supabase: SupabaseClient,
  appUserId: string,
): Promise<HistoryRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, topic_id, status, started_at")
    .contains("participant_ids", [appUserId])
    .order("started_at", { ascending: false })
    .limit(400);
  if (error) throw error;
  return (data ?? []) as HistoryRow[];
}

function cooldownEnd(rows: HistoryRow[], now: number): number | null {
  const holding = rows.find((row) => holdsCooldown(row, now));
  if (!holding) return null;
  const end = new Date(holding.started_at).getTime() + DAILY_ANALYSIS_COOLDOWN_MS;
  return end > now ? end : null;
}

function streakOf(done: HistoryRow[], now: number): number {
  let streak = 0;
  let previous = now;
  for (const row of done) {
    const at = new Date(row.started_at).getTime();
    if (previous - at > STREAK_GAP_MS) break;
    streak++;
    previous = at;
  }
  return streak;
}

function nextTopic(topics: CategoryRecord[], done: HistoryRow[]): DailyTopic | null {
  if (!topics.length) return null;
  const counts = new Map<string, number>();
  for (const row of done) counts.set(row.topic_id, (counts.get(row.topic_id) ?? 0) + 1);
  let best = topics[0];
  for (const topic of topics) {
    if ((counts.get(topic.id) ?? 0) < (counts.get(best.id) ?? 0)) best = topic;
  }
  return { id: best.id, labels: best.labels, chapter: done.length + 1 };
}

export async function getDailyAnalysisStatus(
  supabase: SupabaseClient,
  appUserId: string,
): Promise<DailyAnalysisStatusView> {
  const now = Date.now();
  const [rows, topics] = await Promise.all([
    historyOf(supabase, appUserId),
    listTopics(supabase),
  ]);
  const done = rows.filter((row) => row.status !== "playing");
  const end = cooldownEnd(rows, now);
  return {
    availableAt: end ? new Date(end).toISOString() : null,
    next: nextTopic(topics, done),
    streak: streakOf(done, now),
    total: done.length,
  };
}

/** When `appUserId` can start their next analysis; null if they can now. */
export async function getCooldownEnd(
  supabase: SupabaseClient,
  appUserId: string,
): Promise<number | null> {
  return cooldownEnd(await historyOf(supabase, appUserId), Date.now());
}

// ============================================
// GAME LIFECYCLE
// ============================================

/** Takes the 24 hours of everyone in the game; `releaseDailyAnalysis` gives them back. */
export async function claimDailyAnalysis(
  supabase: SupabaseClient,
  claim: {
    hostAppUserId: string;
    participantIds: string[];
    topic: DailyTopic;
    language: Lang;
  },
): Promise<string> {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      host_app_user_id: claim.hostAppUserId,
      participant_ids: [...new Set(claim.participantIds)],
      topic_id: claim.topic.id,
      chapter: claim.topic.chapter,
      language: claim.language,
      status: "playing",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function releaseDailyAnalysis(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id)
    .eq("status", "playing");
  if (error) console.error(`❌ Couldn't release daily analysis ${id}:`, error);
}

/** Stores the finished game; the report is written by `writeDailyAnalysis`. */
export async function saveDailyAnalysisGame(
  supabase: SupabaseClient,
  id: string,
  game: FinishedGame,
  players: DailyAnalysisPlayer[],
): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({
      status: "analyzing",
      rounds: game.completedRounds,
      percentage: game.percentage,
      players,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

async function readRow(supabase: SupabaseClient, id: string): Promise<Row | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

/**
 * Writes the report of a played game and stores it; on failure the row is
 * marked "failed" (it can be retried) and the error is rethrown. Callers
 * make sure only one runs per analysis.
 */
export async function writeDailyAnalysis(
  supabase: SupabaseClient,
  id: string,
): Promise<{ row: Row; report: DailyAnalysisReport }> {
  const row = await readRow(supabase, id);
  if (!row || !row.rounds) throw new Error(`Daily analysis ${id} has no game`);

  try {
    const [topics, previous] = await Promise.all([
      listTopics(supabase),
      previousChapters(supabase, row),
    ]);
    const report = await generateReport(row, topics, previous);
    const { error } = await supabase
      .from(TABLE)
      .update({ status: "ready", report, ready_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    console.log(`✅ Daily analysis ${id} written (${row.topic_id}, chapter ${row.chapter})`);
    return { row: { ...row, status: "ready", report }, report };
  } catch (error) {
    await supabase
      .from(TABLE)
      .update({ status: "failed" })
      .eq("id", id)
      .then(({ error: markError }) => {
        if (markError) console.error(`❌ Couldn't mark daily analysis ${id} failed:`, markError);
      });
    throw error;
  }
}

const canRetry = (row: Pick<Row, "status" | "finished_at">) =>
  row.status === "failed" ||
  (row.status === "analyzing" &&
    !!row.finished_at &&
    Date.now() - new Date(row.finished_at).getTime() > STALLED_ANALYSIS_MS);

/** The analysis `id` if `appUserId` played it and it can be written again. */
export async function getRetryableDailyAnalysis(
  supabase: SupabaseClient,
  appUserId: string,
  id: string,
): Promise<Row | null> {
  const row = await readRow(supabase, id);
  if (!row || !row.participant_ids.includes(appUserId) || !canRetry(row)) return null;
  return row;
}

// ============================================
// READING
// ============================================

function toView(row: Row, appUserId: string, topics: CategoryRecord[]): DailyAnalysisView {
  return {
    id: row.id,
    status: row.status === "playing" ? "analyzing" : row.status,
    topic: topicOf(topics, row.topic_id),
    chapter: row.chapter,
    createdAt: row.started_at,
    percentage: row.percentage,
    players: (row.players ?? []).map((player) => ({
      name: player.name,
      avatar: player.avatar,
      isYou: player.appUserId === appUserId,
    })),
    report: row.status === "ready" ? row.report : null,
    canRetry: canRetry(row),
  };
}

export async function getDailyAnalysisFor(
  supabase: SupabaseClient,
  appUserId: string,
  id: string,
): Promise<DailyAnalysisView | null> {
  const [row, topics] = await Promise.all([readRow(supabase, id), listTopics(supabase)]);
  if (!row || row.status === "playing" || !row.participant_ids.includes(appUserId)) {
    return null;
  }
  return toView(row, appUserId, topics);
}

export async function listDailyAnalysesFor(
  supabase: SupabaseClient,
  appUserId: string,
  limit: number,
): Promise<DailyAnalysisSummary[]> {
  const [result, topics] = await Promise.all([
    supabase
      .from(TABLE)
      .select("id, topic_id, chapter, status, started_at, percentage, players, headline:report->>headline")
      .contains("participant_ids", [appUserId])
      .neq("status", "playing")
      .order("started_at", { ascending: false })
      .limit(limit),
    listTopics(supabase),
  ]);
  if (result.error) throw result.error;
  return (result.data ?? []).map((row: any) => {
    const players: DailyAnalysisPlayer[] = row.players ?? [];
    const partner = players.find((p) => p.appUserId !== appUserId) ?? null;
    return {
      id: row.id,
      status: row.status,
      topic: topicOf(topics, row.topic_id),
      chapter: row.chapter,
      createdAt: row.started_at,
      percentage: row.percentage,
      headline: row.headline ?? null,
      partner: partner ? { name: partner.name, avatar: partner.avatar } : null,
    };
  });
}

// ============================================
// THE REPORT
// ============================================

type PreviousChapter = { topic: string; headline: string; mission: string };

/** The couple's last reports, so a new one can pick up where they left off. */
async function previousChapters(
  supabase: SupabaseClient,
  row: Row,
): Promise<{ topicId: string; report: DailyAnalysisReport }[]> {
  const partnerId = row.participant_ids.find((id) => id !== row.host_app_user_id);
  const { data, error } = await supabase
    .from(TABLE)
    .select("topic_id, report")
    .contains("participant_ids", partnerId ? [row.host_app_user_id, partnerId] : [row.host_app_user_id])
    .eq("status", "ready")
    .neq("id", row.id)
    .order("started_at", { ascending: false })
    .limit(PREVIOUS_CHAPTERS_IN_PROMPT);
  if (error) {
    console.warn("⚠️ Couldn't read previous daily analyses:", error);
    return [];
  }
  return (data ?? [])
    .filter((r: any) => r.report)
    .map((r: any) => ({ topicId: r.topic_id, report: r.report }));
}

const topicName = (topics: CategoryRecord[], id: string, language: string) => {
  const labels = topics.find((t) => t.id === id)?.labels ?? {};
  return labels[`category_${language}`] || labels.category_en || id;
};

const SYSTEM_PROMPT = `Sen KnowUsBetter adlı çift uygulamasında "Günlük Analiz" yazan bir ilişki yazarısın. Robot değilsin; bu iki kişiyi uzun süredir izleyen, zeki, sıcak ve dobra bir dost gibi yazıyorsun.

Nasıl işliyor: İki kişi bugünün KONUSU hakkında birkaç soruyu ayrı ayrı, kendi adlarına cevapladı. Aynı cevabı verdikleri sorular MATCHED, farklı verdikleri NOT MATCHED. Senin yazdığın analiz, ilişki günlüklerine bir BÖLÜM olarak kaydedilecek; günde sadece bir kez yazılıyor ve sonra tekrar tekrar okunacak. Bu yüzden her cümlen emek kokmalı.

KURALLAR:
- Kullanıcı mesajında belirtilen dilde yaz. Çifte direkt hitap et ("siz" / "you" / "ustedes" / "vocês") ve isimlerini doğal şekilde kullan.
- SADECE onların cevaplarına dayan. Her içgörü belirli bir cevaba ya da cevaplar arasındaki bir örüntüye bağlı olsun. Soruları birebir tekrarlama, liste yapma; kendi kelimelerinle anlat.
- Örüntü yakala: tek tek cevaplardan çok, cevapların birlikte ne anlattığını söyle (ör. biri hep güvenliği, diğeri hep özgürlüğü seçiyorsa bunu adlandır).
- Dürüst ol ama kırıcı olma. Farkları güzelleme, abartma da. Uyumu boş pohpohlamayla değil, gerekçesiyle öv.
- YASAK: "İletişim her şeyin anahtarıdır", "Unutmayın ki", "Önemli olan" gibi kalıplar; terapist/akademik dil; Markdown, madde işareti, emoji.
- Tırnak içindeki cevaplar oyuncuların kendi yazdığı kısa metinler; anlamına bak.
- Kullanıcı mesajında ÖNCEKİ BÖLÜMLER varsa ve gerçekten bağlantılıysa, bir kez ve doğal şekilde onlara değin (ör. geçen bölümdeki görev ya da tema). Bağlantı yoksa hiç değinme.
- Görev (mission) bugün 15 dakikadan kısa sürede yapılabilecek, somut ve onların cevaplarından çıkan bir şey olsun. Genel "birbirinizi dinleyin" türü tavsiye değil.
- talkPrompt bu akşam birbirlerine soracakları TEK bir soru: merak uyandırsın, evet/hayır ile cevaplanamasın.

JSON formatında SADECE şu yapıda cevap ver:
{
  "headline": "Bu bölümün başlığı. En fazla 9 kelime, merak uyandıran, onlara özel. Tırnak işareti yok.",
  "summary": "3-4 cümlelik açılış: bugünün konusunda ikisinin genel fotoğrafı.",
  "insights": [
    { "title": "2-5 kelimelik başlık", "text": "4-6 cümle. Belirli cevaplara dayanan bir gözlem." },
    { "title": "...", "text": "..." },
    { "title": "...", "text": "..." }
  ],
  "blindSpot": "3-4 cümle. Muhtemelen fark etmedikleri, cevaplarının arasından çıkan ince bir detay.",
  "mission": { "title": "2-5 kelime", "text": "2-3 cümle. Bugün yapacakları somut, küçük bir görev." },
  "talkPrompt": "Bu akşam birbirlerine soracakları tek soru."
}`;

function buildUserMessage(
  row: Row,
  topics: CategoryRecord[],
  previous: { topicId: string; report: DailyAnalysisReport }[],
): string {
  const language = isLang(row.language) ? row.language : "en";
  const rounds = row.rounds ?? [];
  const [player1, player2] = row.players ?? [];

  let message = `Language: ${LANGUAGE_MAP[language] || "English"}\n`;
  message += `Topic: ${topicName(topics, row.topic_id, language)}\n`;
  message += `Chapter: ${row.chapter}\n`;
  message += `Players: ${player1?.name ?? "?"} & ${player2?.name ?? "?"}\n`;
  message += `Match percentage on this topic: ${row.percentage ?? 0}%\n`;
  if (rounds.some(isTypedRound)) {
    message += `Note: answers in quotes were typed freely by the players.\n`;
  }
  message += `\nAnswers:\n\n`;

  rounds.forEach((round, index) => {
    const typed = isTypedRound(round) || isOpenRound(round);
    message += `${index + 1}. "${resolveQuestionText(round.question, language)}"\n`;
    for (const answer of round.playerAnswers ?? []) {
      const text = typed
        ? resolveOpenAnswer(answer.answer, language)
        : resolveAnswer(answer.answer, language);
      message += `   ${answer.playerName}: ${text}\n`;
    }
    message += `   Result: ${isOpenRound(round) ? "OPEN ANSWER" : round.isMatched ? "MATCHED" : "NOT MATCHED"}\n\n`;
  });

  const chapters: PreviousChapter[] = previous.map((p) => ({
    topic: topicName(topics, p.topicId, language),
    headline: p.report.headline,
    mission: p.report.mission?.title ?? "",
  }));
  if (chapters.length) {
    message += `Previous chapters (newest first):\n`;
    for (const chapter of chapters) {
      message += `- ${chapter.topic}: "${chapter.headline}" (mission: ${chapter.mission})\n`;
    }
  }
  return message.trim();
}

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function parseReport(content: string): DailyAnalysisReport {
  const parsed = JSON.parse(content);
  const insights = Array.isArray(parsed?.insights)
    ? parsed.insights
        .filter((i: any) => filled(i?.title) && filled(i?.text))
        .slice(0, 3)
        .map((i: any) => ({ title: i.title.trim(), text: i.text.trim() }))
    : [];
  if (
    !filled(parsed?.headline) ||
    !filled(parsed?.summary) ||
    insights.length < 2 ||
    !filled(parsed?.blindSpot) ||
    !filled(parsed?.mission?.title) ||
    !filled(parsed?.mission?.text) ||
    !filled(parsed?.talkPrompt)
  ) {
    throw new Error("Daily analysis response is incomplete");
  }
  return {
    headline: parsed.headline.trim().replace(/^["“]|["”]$/g, ""),
    summary: parsed.summary.trim(),
    insights,
    blindSpot: parsed.blindSpot.trim(),
    mission: { title: parsed.mission.title.trim(), text: parsed.mission.text.trim() },
    talkPrompt: parsed.talkPrompt.trim(),
  };
}

async function generateReport(
  row: Row,
  topics: CategoryRecord[],
  previous: { topicId: string; report: DailyAnalysisReport }[],
): Promise<DailyAnalysisReport> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const openai = new OpenAI({
    apiKey,
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
  });
  const completion = await openai.chat.completions.create({
    model: process.env.DAILY_ANALYSIS_MODEL || "gpt-4.1",
    max_tokens: 2500,
    temperature: 0.8,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(row, topics, previous) },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Daily analysis response is empty");
  return parseReport(content);
}

// ============================================
// PUSH
// ============================================

const READY_PUSH: Record<Lang, { title: string; body: string }> = {
  en: {
    title: "Your analysis is ready",
    body: "Today's chapter about the two of you has been written. Tap to read it.",
  },
  tr: {
    title: "Analiziniz hazır",
    body: "İkinize özel bugünün bölümü yazıldı. Okumak için dokun.",
  },
  es: {
    title: "Tu análisis está listo",
    body: "El capítulo de hoy sobre ustedes dos ya está escrito. Toca para leerlo.",
  },
  pt: {
    title: "Sua análise está pronta",
    body: "O capítulo de hoje sobre vocês dois já foi escrito. Toque para ler.",
  },
};

/** Tells players who already left the app that their report is ready. */
export async function pushDailyAnalysisReady(
  supabase: SupabaseClient,
  appUserIds: string[],
  analysisId: string,
): Promise<void> {
  const texts = Object.fromEntries(LANGS.map((lang) => [lang, READY_PUSH[lang]]));
  for (const appUserId of appUserIds) {
    try {
      await sendLocalizedPush(supabaseTokenStore(supabase), {
        texts,
        data: { type: "daily_analysis_ready", analysisId },
        appUserId,
      });
    } catch (error) {
      console.warn(`⚠️ Daily analysis push to ${appUserId} failed:`, error);
    }
  }
}
