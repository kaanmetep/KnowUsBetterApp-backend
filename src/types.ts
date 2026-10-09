export type RoomStatus = "waiting" | "playing" | "finished";

// Category ids come from public.categories; a new row there is enough.
export type Category = string;

// "choice" = yes/no or multiple choice (decided by haveAnswers),
// "text" = both players type a free-form answer, matched by meaning (utils/textMatch).
export type QuestionType = "choice" | "text";

export const CLIENT_FEATURE_TEXT_QUESTIONS = "text_questions";
// The app leaves coin spending to the server (game start, AI analysis). Older
// builds spend from the client, so the server only charges hosts that send it.
export const CLIENT_FEATURE_SERVER_COINS = "server_coins";

export type GameMode = "see_your_match" | "know_each_other" | "who_knows_better";

export interface Question {
  id: string; // UUID from Supabase
  texts: {
    text_en: string;
    text_tr: string;
    text_es: string; // Spanish
  };
  category: Category;
  haveAnswers: boolean; // true = has answers, false = only yes/no answers
  answers: {
    answers_en: string[];
    answers_tr: string[];
    answers_es: string[];
  } | null; // answers with translations (JSONB) or null for yes/no
  // Optional so rooms already stored in Redis before this field existed still parse.
  questionType?: QuestionType;
  // General knowledge question: answers are graded against an answer key that
  // stays on the server (see utils/trivia) until the round is over.
  isTrivia?: boolean;
}

/** What clients get as `question.correctAnswer` once a trivia round is over. */
export type RevealedAnswer = string | MultiLanguageAnswer;

// Multi-language answer object (for questions with haveAnswers = true)
export interface MultiLanguageAnswer {
  en: string;
  tr: string;
  es: string;
}

export interface QuestionRound {
  question: Question;
  answers: {
    [playerId: string]: string | MultiLanguageAnswer | null; // Each player's answer (null if not answered yet, string for yes/no, MultiLanguageAnswer for multi-choice)
  };
  isMatched: boolean | null; // null = not completed, true/false = match result
  // false = excluded from matchScore and the percentage (text rounds played before they were scored).
  isScored?: boolean;
  // Trivia only, filled in when the round completes.
  correct?: { [playerId: string]: boolean };
  correctAnswer?: RevealedAnswer;
  status: "waiting_answers" | "completed";
  /** Server time the round was sent out; tells apart rounds of the same question in replays. */
  startedAt?: number;
}

export interface Player {
  id: string;
  name: string;
  avatar: string;
  isHost: boolean;
  hasAnswered: boolean; // Has answered current question
  // Older app builds can't render text questions, so they only get them
  // when every player in the room supports them.
  supportsTextQuestions?: boolean;
  supportsServerCoins?: boolean;
}

export interface RoomSettings {
  maxPlayers: number;
  totalQuestions: number;
  category: Category;
  questionDuration: number; // Time to answer each question (seconds)
  resultDisplayDuration: number; // Time to show results before next question (seconds)
  textQuestionDuration?: number;
  textResultDisplayDuration?: number;
  /** Set from the category; missing on rooms stored before it existed. */
  mode?: GameMode;
}

export interface Room {
  roomCode: string;
  createdAt: number;
  status: RoomStatus;
  players: Player[];
  questions: Question[]; // All questions for this game (fetched once at start)
  currentQuestionIndex: number;
  currentRound: QuestionRound | null; // Current active question round
  completedRounds: QuestionRound[]; // History of completed rounds
  matchScore: number; // Number of matched answers
  totalQuestionsAnswered: number; // Total questions answered
  settings: RoomSettings;
}

export interface JoinRoomSuccess {
  success: true;
  player: Player;
  room: Room;
}

/**
 * Stable id of a room-error. `message` stays in English for older builds that
 * display it as is; current builds show their own translation for the code.
 */
export type RoomErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "GAME_IN_PROGRESS"
  | "NOT_HOST"
  | "NEED_PARTNER"
  | "PARTNER_DISCONNECTED"
  | "PLAYER_NOT_FOUND"
  | "CANNOT_KICK_SELF"
  | "UPDATE_REQUIRED"
  | "QUESTIONS_UNAVAILABLE"
  | "INSUFFICIENT_COINS"
  | "COINS_UNAVAILABLE"
  | "USER_BANNED"
  | "REQUEST_FAILED";

export interface JoinRoomError {
  success: false;
  error: string;
  code: RoomErrorCode;
}

export type JoinRoomResult = JoinRoomSuccess | JoinRoomError;

export interface CreateRoomData {
  playerName: string;
  avatar: string;
  category: Category;
  clientFeatures?: string[];
}

export interface JoinRoomData {
  roomCode: string;
  playerName: string;
  avatar: string;
  clientFeatures?: string[];
}

export interface GetRoomData {
  roomCode: string;
}

// Game Event Types
export interface SubmitAnswerData {
  questionId: string; // UUID from Supabase
  answer: string; // Answer text (e.g., "yes", "no", or custom answer)
}
