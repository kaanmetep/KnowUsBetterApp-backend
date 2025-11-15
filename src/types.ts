export type RoomStatus = "waiting" | "playing" | "finished";

export type Category = "just-friends" | "we_just_met" | "long_term" | "spicy";

export interface Question {
  id: string; // UUID from Supabase
  texts: {
    text_en: string;
    text_tr: string;
    text_es: string; // Spanish
  };
  category: Category;
  haveAnswers: boolean; // true = has answers, false = only yes/no answers
  answers: string[]; // answers to the question
}

export interface QuestionRound {
  question: Question;
  answers: {
    [playerId: string]: string | null; // Each player's answer (null if not answered yet)
  };
  isMatched: boolean | null; // null = not completed, true/false = match result
  status: "waiting_answers" | "completed";
}

export interface Player {
  id: string;
  name: string;
  avatar: string;
  isHost: boolean;
  hasAnswered: boolean; // Has answered current question
}

export interface RoomSettings {
  maxPlayers: number;
  totalQuestions: number;
  category: Category;
  questionDuration: number; // Time to answer each question (seconds)
  resultDisplayDuration: number; // Time to show results before next question (seconds)
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

export interface JoinRoomError {
  success: false;
  error: string;
}

export type JoinRoomResult = JoinRoomSuccess | JoinRoomError;

export interface CreateRoomData {
  playerName: string;
  avatar: string;
  category: Category;
}

export interface JoinRoomData {
  roomCode: string;
  playerName: string;
  avatar: string;
}

export interface GetRoomData {
  roomCode: string;
}

// Game Event Types
export interface SubmitAnswerData {
  questionId: string; // UUID from Supabase
  answer: string; // Answer text (e.g., "yes", "no", or custom answer)
}
