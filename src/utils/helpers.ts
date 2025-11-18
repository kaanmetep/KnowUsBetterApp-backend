import { Server, Socket } from "socket.io";
import {
  Category,
  CreateRoomData,
  JoinRoomData,
  GetRoomData,
  SubmitAnswerData,
  Question,
  MultiLanguageAnswer,
} from "../types.js";

// Socket.io Event Types (needed for helper functions)
export interface SocketData {
  appUserId?: string;
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
  "room-error": (data: { message: string }) => void;
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
    playerAnswers: Array<{
      playerId: string;
      playerName: string;
      avatar: string;
      answer: string | { en: string; tr: string; es: string } | null;
    }>;
    question: any;
    matchScore: number;
    totalQuestions: number;
    percentage: number;
  }) => void;
  "game-finished": (data: {
    matchScore: number;
    totalQuestions: number;
    percentage: number;
    completedRounds: any[];
  }) => void;
  "next-question": (data: {
    question: any;
    currentQuestionIndex: number;
    totalQuestions: number;
    serverTime: number;
    duration: number;
  }) => void;
  "kicked-from-room": (data: { message: string; roomCode: string }) => void;
  "player-kicked": (data: {
    playerId: string;
    playerName: string;
    room: any;
  }) => void;
  "game-cancelled": (data: { message: string; room: any }) => void;
  "chat-message": (data: {
    playerId: string;
    playerName: string;
    avatar: string;
    message: string;
    timestamp: number;
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
}

export interface ClientToServerEvents {
  "create-room": (data: CreateRoomData) => void;
  "join-room": (data: JoinRoomData) => void;
  "get-room": (data: GetRoomData) => void;
  "leave-room": (data: { roomCode: string }) => void;
  "start-game": (data: { roomCode: string }) => void;
  "submit-answer": (data: SubmitAnswerData) => void;
  "kick-player": (data: { roomCode: string; targetPlayerId: string }) => void;
  "send-message": (data: { roomCode: string; message: string }) => void;
  "register-user": (appUserId: string) => void;
  "spend-coins": (data: {
    appUserId: string;
    amount: number;
    transactionType?: string;
  }) => void;
}

// Get coins from product id.
export function getCoinsFromProductId(productId: string): number {
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

// Check if message contains only valid characters (prevent injection)
export function isValidMessage(message: string): boolean {
  // Allow letters, numbers, spaces, common punctuation, and emojis
  // Reject if contains suspicious patterns
  const suspiciousPatterns = [
    /<script/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
    /data:text\/html/gi,
  ];

  return !suspiciousPatterns.some((pattern) => pattern.test(message));
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
