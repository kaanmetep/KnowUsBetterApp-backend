import { Server, Socket } from "socket.io";
import {
  Category,
  GameMode,
  CreateRoomData,
  JoinRoomData,
  GetRoomData,
  SubmitAnswerData,
  Question,
  MultiLanguageAnswer,
  QuestionRound,
  Room,
  RoomErrorCode,
  RoomSettings,
} from "../types.js";
import { maskProfanity } from "./profanity.js";
import type { GameSummary } from "../services/finishedGames.js";
import type { AiAnalysisUpdate } from "../services/sharedAnalysis.js";
import type { ReactionAnimation } from "../services/reactionService.js";

// Socket.io Event Types (needed for helper functions)
export interface SocketData {
  appUserId?: string;
  /** A register-user that couldn't be checked because the database failed. */
  unverifiedRegistration?: { appUserId: string; token: unknown };
}

export interface ServerToClientEvents {
  "room-created": (data: {
    roomCode: string;
    player: any;
    category: Category;
  }) => void;
  "room-joined": (data: { roomCode: string; player: any; room: any }) => void;
  "player-joined": (data: { player: any; room: any }) => void;
  "player-left": (data: { playerId: string; room: any }) => void;
  "room-data": (room: any) => void;
  "room-error": (data: {
    message: string;
    code: RoomErrorCode;
    required?: number;
    balance?: number;
  }) => void;
  "critical-error": (data: { message: string; code?: string }) => void;
  "room-left": () => void;
  "game-started": (data: {
    room: any;
    question: any;
    totalQuestions: number;
    serverTime: number;
    duration: number;
  }) => void;
  "player-answered": (data: {
    playerId: string;
    playerName: string | undefined;
  }) => void;
  "round-completed": (data: {
    allPlayersAnswered: boolean;
    isMatched: boolean;
    isScored: boolean;
    questionType: "choice" | "text";
    displayDuration: number;
    playerAnswers: Array<{
      playerId: string;
      playerName: string;
      avatar: string;
      answer: string | { en: string; tr: string; es: string } | null;
      /** Trivia only. */
      isCorrect?: boolean;
    }>;
    question: any;
    matchScore: number;
    totalQuestions: number;
    percentage: number;
  }) => void;
  "game-finished": (data: {
    /** Identifies the game for the AI analysis. */
    gameId: string;
    mode: GameMode;
    matchScore: number;
    totalQuestions: number;
    percentage: number;
    completedRounds: any[];
    summary: GameSummary;
    /** The room, already reset for a replay. */
    room: Room | null;
  }) => void;
  "next-question": (data: {
    question: any;
    currentQuestionIndex: number;
    totalQuestions: number;
    serverTime: number;
    duration: number;
  }) => void;
  "kicked-from-room": (data: {
    message: string;
    roomCode: string;
    hostName: string;
  }) => void;
  "player-kicked": (data: {
    playerId: string;
    playerName: string;
    room: any;
  }) => void;
  "game-cancelled": (data: {
    message: string;
    code: "PLAYER_LEFT" | "SERVER_ERROR";
    room: any;
  }) => void;
  "coins-added": (data: {
    appUserId: string;
    newBalance: number;
    success: boolean;
  }) => void;
  "coins-spent": (data: {
    appUserId: string;
    newBalance: number;
    success: boolean;
    error?: string;
  }) => void;
  "daily-reward-claimed": (data: {
    appUserId: string;
    success: boolean;
    newBalance?: number;
    nextClaimAt?: string;
    error?: string;
  }) => void;
  "category-changed": (data: { room: any }) => void;
  /** The shared AI analysis of a finished game started, finished or failed. */
  "ai-analysis-update": (data: AiAnalysisUpdate) => void;
  /** Payload-free broadcast that gives the app a recent recovery offset. */
  "connection-sync": () => void;
  /** The partner sent a reaction; carries everything needed to play it. */
  "reaction-received": (data: ReactionEvent) => void;
}

export interface ReactionEvent {
  /** Unique per send. */
  id: string;
  reactionId: string;
  emoji: string;
  animation: ReactionAnimation;
  color: string;
  labels: Record<string, string>;
  fromPlayerId: string;
  sentAt: number;
}

export type SendReactionResult =
  | { ok: true; id: string; cooldownMs: number; newBalance?: number }
  | {
      ok: false;
      code:
        | "COOLDOWN"
        | "INSUFFICIENT_COINS"
        | "COINS_UNAVAILABLE"
        | "NOT_IN_GAME"
        | "PARTNER_OFFLINE"
        | "PARTNER_UPDATE_REQUIRED"
        | "UNKNOWN_REACTION"
        | "PRICE_CHANGED"
        | "UNAVAILABLE";
      retryAfterMs?: number;
      required?: number;
      balance?: number;
    };

export interface ClientToServerEvents {
  "create-room": (data: CreateRoomData) => void;
  "join-room": (data: JoinRoomData) => void;
  "get-room": (data: GetRoomData) => void;
  "leave-room": (data: { roomCode: string }) => void;
  /** `appUserId` pays for the category when the socket isn't registered yet. */
  "start-game": (data: { roomCode: string; appUserId?: string }) => void;
  "submit-answer": (data: SubmitAnswerData) => void;
  "kick-player": (data: { roomCode: string; targetPlayerId: string }) => void;
  "register-user": (
    payload: string | { appUserId: string; token?: string | null },
  ) => void;
  "spend-coins": (data: {
    appUserId: string;
    amount: number;
    transactionType?: string;
  }) => void;
  "claim-daily-reward": (data: { appUserId: string }) => void;
  "change-category": (data: { roomCode: string; category: Category }) => void;
  "report-answer": (
    data: ReportAnswerData,
    ack?: (result: { success: boolean }) => void,
  ) => void;
  /** Where the shared AI analysis of a finished game stands; null if unknown. */
  "get-ai-analysis": (
    data: { gameId: string },
    ack?: (state: AiAnalysisUpdate | null) => void,
  ) => void;
  /**
   * `appUserId` pays for a paid reaction when the socket isn't registered yet.
   * `coinCost` is the price the player saw; it's never charged at another one.
   */
  "send-reaction": (
    data: { reactionId: string; appUserId?: string; coinCost?: number },
    ack?: (result: SendReactionResult) => void,
  ) => void;
}

export interface ReportAnswerData {
  questionId: string;
  reportedPlayerId: string;
  reason?: string;
}

/**
 * Coins granted by a store product. The configured packages win; the number
 * in the product id is only a fallback so a paid product missing from the
 * config is still credited.
 */
export function getCoinsFromProductId(
  productId: string,
  packages: { productId: string; coins: number }[] = [],
): number {
  const configured = packages.find((pkg) => pkg.productId === productId);
  if (configured) return configured.coins;
  const match = productId.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// Find socket by appUserId.
export function findSocketByUserId(
  appUserId: string,
  io: Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>,
  userSockets: Map<string, string>
): Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData> | null {
  const socketId = userSockets.get(appUserId);
  if (socketId) {
    return (
      (io.sockets.sockets.get(socketId) as
        | Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>
        | undefined) || null
    );
  }
  return null;
}

// Sanitize message to prevent XSS attacks.
export function sanitizeMessage(message: string): string {
  // Remove HTML tags and script content
  return message
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/javascript:/gi, "") // Remove javascript: protocol
    .replace(/on\w+\s*=/gi, ""); // Remove event handlers (onclick=, etc.)
}

export const TEXT_ANSWER_MAX_LENGTH = 30;
/** Stored in place of a typed answer the moderation model flagged; clients render it as "answer hidden". */
export const HIDDEN_TEXT_ANSWER = "[[hidden]]";
const DEFAULT_TEXT_QUESTION_DURATION = 30;
const DEFAULT_TEXT_RESULT_DISPLAY_DURATION = 6;

export function isTextQuestion(question: Question | null | undefined): boolean {
  return question?.questionType === "text";
}

/** Single-line, length-capped, tag-free version of a typed answer ("" if unusable). */
export function normalizeTextAnswer(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const collapsed = raw
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const capped = Array.from(sanitizeMessage(collapsed).trim())
    .slice(0, TEXT_ANSWER_MAX_LENGTH)
    .join("")
    .trim();
  return maskProfanity(capped);
}

// The app caps names at 16; anything else came from a modified client.
const PLAYER_NAME_MAX_LENGTH = 20;
const AVATAR_ID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Player names are shown to the other player, so they get the same masking.
 * Always a short single-line string: the partner's app renders it as text.
 */
export function cleanPlayerName(name: unknown): string {
  if (typeof name !== "string") return "";
  const capped = Array.from(
    name.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim(),
  )
    .slice(0, PLAYER_NAME_MAX_LENGTH)
    .join("")
    .trim();
  return maskProfanity(capped);
}

/** An avatar id like "girl_avatar_3"; anything else shows the default avatar. */
export function cleanAvatar(avatar: unknown): string {
  return typeof avatar === "string" && AVATAR_ID.test(avatar) ? avatar : "";
}

export function getQuestionDuration(
  settings: RoomSettings,
  question: Question | null | undefined,
): number {
  return isTextQuestion(question)
    ? settings.textQuestionDuration ?? DEFAULT_TEXT_QUESTION_DURATION
    : settings.questionDuration;
}

export function getResultDisplayDuration(
  settings: RoomSettings,
  question: Question | null | undefined,
): number {
  return isTextQuestion(question)
    ? settings.textResultDisplayDuration ?? DEFAULT_TEXT_RESULT_DISPLAY_DURATION
    : settings.resultDisplayDuration;
}

/** The round's question plus `correctAnswer` once a trivia round is over. */
export function withRevealedAnswer(round: QuestionRound) {
  return round.correctAnswer === undefined
    ? round.question
    : { ...round.question, correctAnswer: round.correctAnswer };
}

/** Shape of `completedRounds` in "game-finished" (also what the AI analysis receives). */
export function buildFinishedRounds(room: Room) {
  return room.completedRounds.map((round) => ({
    ...round,
    isScored: round.isScored ?? true,
    question: {
      ...withRevealedAnswer(round),
      questionType: round.question.questionType ?? "choice",
      // Flatten texts for AI analysis compatibility
      text_en: round.question.texts.text_en,
      text_tr: round.question.texts.text_tr,
      text_es: round.question.texts.text_es,
    },
    playerAnswers: room.players.map((p) => ({
      playerId: p.id,
      playerName: p.name,
      avatar: p.avatar,
      answer: round.answers[p.id],
      ...(round.correct && { isCorrect: round.correct[p.id] === true }),
    })),
  }));
}

// Helper function to find answer object from user input
export function findAnswerObject(
  userAnswer: string,
  question: Question
): MultiLanguageAnswer | null {
  if (!question.haveAnswers || !question.answers) {
    return null;
  }

  const { answers_en, answers_tr, answers_es } = question.answers;

  // Try to find the answer in each language array
  let answerIndex = -1;

  // Check English
  answerIndex = answers_en.findIndex((ans) => ans === userAnswer);
  if (answerIndex !== -1) {
    return {
      en: answers_en[answerIndex],
      tr: answers_tr[answerIndex] || answers_en[answerIndex],
      es: answers_es[answerIndex] || answers_en[answerIndex],
    };
  }

  // Check Turkish
  answerIndex = answers_tr.findIndex((ans) => ans === userAnswer);
  if (answerIndex !== -1) {
    return {
      en: answers_en[answerIndex] || answers_tr[answerIndex],
      tr: answers_tr[answerIndex],
      es: answers_es[answerIndex] || answers_tr[answerIndex],
    };
  }

  // Check Spanish
  answerIndex = answers_es.findIndex((ans) => ans === userAnswer);
  if (answerIndex !== -1) {
    return {
      en: answers_en[answerIndex] || answers_es[answerIndex],
      tr: answers_tr[answerIndex] || answers_es[answerIndex],
      es: answers_es[answerIndex],
    };
  }

  // Answer not found in any language
  return null;
}
