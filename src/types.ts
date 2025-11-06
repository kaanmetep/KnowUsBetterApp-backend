export type RoomStatus = "waiting" | "playing" | "finished";

export type Category = "just-friends" | "we_just_met" | "long_term" | "spicy";

export interface Question {
  id: number;
  question: string;
  answers: string[];
  correctAnswer: number;
}

export interface Player {
  id: string;
  name: string;
  avatar: string;
  isHost: boolean;
  score: number;
  answeredQuestions: number[];
}

export interface RoomSettings {
  maxPlayers: number;
  questionsCount: number;
  category: Category;
}

export interface Room {
  roomCode: string;
  createdAt: number;
  status: RoomStatus;
  players: Player[];
  currentQuestionIndex: number;
  questions: Question[];
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
