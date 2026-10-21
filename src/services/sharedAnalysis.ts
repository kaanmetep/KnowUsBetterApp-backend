import { redis } from "../utils/redis.js";
import { FINISHED_GAME_TTL_SECONDS, FinishedGame } from "./finishedGames.js";

/**
 * One AI analysis per finished game, shared by both players: whoever starts
 * it pays, and both get the same report.
 */

export type DefaultAnalysis = {
  strengths: string;
  differences: string;
  tips: string;
  compatibility: string;
};
export type KnowMeWellAnalysis = {
  player1AboutPlayer2: string;
  player2AboutPlayer1: string;
};
export type AnalysisResult = DefaultAnalysis | KnowMeWellAnalysis;

type Starter = { requesterId: string; requesterName: string };

type SharedAnalysis = Starter & {
  language: string;
  /** Player 1 is the requester. */
  result: AnalysisResult;
};

/** What a player's app is told about their game's analysis. */
export type AiAnalysisUpdate =
  | { gameId: string; status: "idle" }
  | {
      gameId: string;
      status: "running" | "failed";
      requesterName: string;
      byYou: boolean;
    }
  | {
      gameId: string;
      status: "ready";
      requesterName: string;
      byYou: boolean;
      /** Already turned so that player 1 is the receiving player. */
      result: AnalysisResult;
    };

const resultKey = (gameId: string) => `aiShared:${gameId}`;
const runningKey = (gameId: string) => `aiRunning:${gameId}`;

const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/** know_me_well chapters are written from player 1's side. */
export function resultFor(
  result: AnalysisResult,
  requesterId: string,
  playerId: string,
): AnalysisResult {
  if (playerId === requesterId || !("player1AboutPlayer2" in result)) {
    return result;
  }
  return {
    player1AboutPlayer2: result.player2AboutPlayer1,
    player2AboutPlayer1: result.player1AboutPlayer2,
  };
}

export async function getSharedAnalysis(
  gameId: string,
): Promise<SharedAnalysis | null> {
  return parse<SharedAnalysis>(await redis.get(resultKey(gameId)));
}

export async function saveSharedAnalysis(
  gameId: string,
  analysis: SharedAnalysis,
): Promise<void> {
  await redis.setex(
    resultKey(gameId),
    FINISHED_GAME_TTL_SECONDS,
    JSON.stringify(analysis),
  );
}

/**
 * Doubles as the lock: only one player's analysis runs at a time, so only
 * one of them pays. Returns who holds it when it's taken.
 */
export async function claimAnalysis(
  gameId: string,
  starter: Starter,
  ttlSeconds: number,
): Promise<{ ok: true } | { ok: false; holder: Starter | null }> {
  const taken = await redis
    .set(runningKey(gameId), JSON.stringify(starter), "EX", ttlSeconds, "NX")
    .catch(() => null);
  if (taken === "OK") return { ok: true };
  const holder = await redis.get(runningKey(gameId)).catch(() => null);
  return { ok: false, holder: parse<Starter>(holder) };
}

export async function releaseAnalysis(gameId: string): Promise<void> {
  await redis
    .del(runningKey(gameId))
    .catch((error) => console.error("Error releasing AI analysis:", error));
}

/** The analysis state as `playerId` should see it. */
export async function getAnalysisStateFor(
  game: FinishedGame,
  playerId: string,
): Promise<AiAnalysisUpdate> {
  const { gameId } = game;
  const shared = await getSharedAnalysis(gameId);
  if (shared) {
    return {
      gameId,
      status: "ready",
      requesterName: shared.requesterName,
      byYou: shared.requesterId === playerId,
      result: resultFor(shared.result, shared.requesterId, playerId),
    };
  }
  const running = parse<Starter>(await redis.get(runningKey(gameId)));
  if (running) {
    return {
      gameId,
      status: "running",
      requesterName: running.requesterName,
      byYou: running.requesterId === playerId,
    };
  }
  return { gameId, status: "idle" };
}
