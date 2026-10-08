import { randomUUID } from "crypto";
import { Room } from "../types.js";
import { MatchTierConfig } from "../types/publicConfig.js";
import { buildFinishedRounds } from "../utils/helpers.js";
import { redis } from "../utils/redis.js";
import { GameMode } from "./categoryService.js";

/** Long enough to open the AI analysis after lingering on the results. */
export const FINISHED_GAME_TTL_SECONDS = 2 * 60 * 60;

const finishedGameKey = (gameId: string) => `finishedGame:${gameId}`;
const playerGameKey = (playerId: string) => `finishedGameByPlayer:${playerId}`;

export interface PlayerScore {
  playerId: string;
  correct: number;
  total: number;
  percent: number;
  bestStreak: number;
}

/**
 * The results the app shows, decided here so every client agrees:
 * - see_your_match: the tier for the match percentage
 * - know_each_other: how well each player guessed the other (as the guesser)
 * - who_knows_better: each player's correct answers
 */
export interface GameSummary {
  mode: GameMode;
  tier?: { key: string; celebrate: boolean };
  players?: PlayerScore[];
  /** null on a tie. */
  winnerId?: string | null;
}

export interface FinishedGame {
  gameId: string;
  roomCode: string;
  categoryId: string;
  mode: GameMode;
  players: { id: string; name: string; avatar: string }[];
  completedRounds: ReturnType<typeof buildFinishedRounds>;
  matchScore: number;
  totalQuestions: number;
  percentage: number;
  summary: GameSummary;
  finishedAt: number;
}

const percentOf = (correct: number, total: number) =>
  total ? Math.round((correct / total) * 100) : 0;

const winnerBy = (scores: PlayerScore[], key: "correct" | "percent") =>
  scores.length < 2 || scores[0][key] === scores[1][key]
    ? null
    : scores[0][key] > scores[1][key]
      ? scores[0].playerId
      : scores[1].playerId;

export function getMatchTier(percentage: number, tiers: MatchTierConfig[]) {
  const sorted = [...tiers].sort((a, b) => b.min - a.min);
  const tier =
    sorted.find((item) => percentage >= item.min) ?? sorted[sorted.length - 1];
  return { key: tier.key, celebrate: tier.celebrate };
}

/**
 * Even rounds are about player 1 and guessed by player 2, odd rounds the
 * reverse; the app asks them in that order.
 */
function knowMeWellScores(room: Room): PlayerScore[] {
  const [player1, player2] = room.players;
  const guessed = (parity: 0 | 1, playerId: string): PlayerScore => {
    const rounds = room.completedRounds.filter((_, i) => i % 2 === parity);
    const correct = rounds.filter((round) => round.isMatched === true).length;
    return {
      playerId,
      correct,
      total: rounds.length,
      percent: percentOf(correct, rounds.length),
      bestStreak: 0,
    };
  };
  return [
    ...(player1 ? [guessed(1, player1.id)] : []),
    ...(player2 ? [guessed(0, player2.id)] : []),
  ];
}

function triviaScores(room: Room): PlayerScore[] {
  return room.players.map((player) => {
    let correct = 0;
    let total = 0;
    let run = 0;
    let bestStreak = 0;
    for (const round of room.completedRounds) {
      const result = round.correct?.[player.id];
      if (result === undefined) continue;
      total++;
      if (result) {
        correct++;
        run++;
        bestStreak = Math.max(bestStreak, run);
      } else {
        run = 0;
      }
    }
    return {
      playerId: player.id,
      correct,
      total,
      percent: percentOf(correct, total),
      bestStreak,
    };
  });
}

export function summarizeGame(
  room: Room,
  mode: GameMode,
  percentage: number,
  tiers: MatchTierConfig[],
): GameSummary {
  if (mode === "who_knows_better") {
    const players = triviaScores(room);
    return { mode, players, winnerId: winnerBy(players, "correct") };
  }
  if (mode === "know_each_other") {
    const players = knowMeWellScores(room);
    return { mode, players, winnerId: winnerBy(players, "percent") };
  }
  return { mode, tier: getMatchTier(percentage, tiers) };
}

export function getGamePercentage(room: Room): number {
  return percentOf(room.matchScore, room.totalQuestionsAnswered);
}

export async function recordFinishedGame(
  room: Room,
  mode: GameMode,
  tiers: MatchTierConfig[],
): Promise<FinishedGame> {
  const percentage = getGamePercentage(room);
  const game: FinishedGame = {
    gameId: randomUUID(),
    roomCode: room.roomCode,
    categoryId: room.settings.category,
    mode,
    players: room.players.map(({ id, name, avatar }) => ({ id, name, avatar })),
    completedRounds: buildFinishedRounds(room),
    matchScore: room.matchScore,
    totalQuestions: room.totalQuestionsAnswered,
    percentage,
    summary: summarizeGame(room, mode, percentage, tiers),
    finishedAt: Date.now(),
  };

  try {
    const pipeline = redis
      .multi()
      .setex(finishedGameKey(game.gameId), FINISHED_GAME_TTL_SECONDS, JSON.stringify(game));
    // Older builds ask for the analysis without a gameId.
    for (const player of game.players) {
      pipeline.setex(playerGameKey(player.id), FINISHED_GAME_TTL_SECONDS, game.gameId);
    }
    await pipeline.exec();
  } catch (error) {
    // The results still go out; only the AI analysis needs the stored copy.
    console.error("❌ Failed to store finished game:", error);
  }
  return game;
}

/** The last game this player (socket id) finished, if still stored. */
export async function getLastFinishedGameOf(
  playerId: string,
): Promise<FinishedGame | null> {
  const gameId = await redis.get(playerGameKey(playerId));
  return gameId ? getFinishedGame(gameId) : null;
}

export async function getFinishedGame(
  gameId: string,
): Promise<FinishedGame | null> {
  const raw = await redis.get(finishedGameKey(gameId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FinishedGame;
  } catch {
    return null;
  }
}
