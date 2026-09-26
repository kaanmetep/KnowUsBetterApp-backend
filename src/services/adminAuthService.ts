import crypto from "crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { redis } from "../utils/redis.js";
import { ensureAdminSchema, getAdminPool } from "../utils/adminDb.js";
import { AppError } from "../errors/AppError.js";

const KEY_PREFIX = "admin_panel:";
const CHALLENGE_TTL_SECONDS = 300;
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const STEP_UP_TTL_MS = 2 * 60 * 1000;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_SECONDS = 15 * 60;

type ChallengeKind = "register" | "authenticate";

interface StoredPasskey {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
}

interface AdminSession {
  createdAt: number;
  stepUpUntil: number | null;
}

export function getWebAuthnConfig(): { rpID: string; origin: string } {
  const externalUrl = process.env.ADMIN_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  const origin = externalUrl
    ? new URL(externalUrl).origin
    : `http://localhost:${process.env.PORT || 3000}`;
  const rpID = process.env.ADMIN_RP_ID || new URL(origin).hostname;
  return { rpID, origin };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function isValidSetupToken(provided: unknown): boolean {
  const expected = process.env.ADMIN_SETUP_TOKEN;
  if (!expected || expected.length < 16 || typeof provided !== "string") {
    return false;
  }
  return safeEqual(provided, expected);
}

async function loadPasskeys(): Promise<StoredPasskey[]> {
  await ensureAdminSchema();
  const { rows } = await getAdminPool().query(
    "SELECT id, public_key, counter, transports FROM admin_panel.passkeys",
  );
  return rows.map((row) => ({
    id: row.id,
    publicKey: new Uint8Array(row.public_key as Buffer),
    counter: Number(row.counter),
    transports: row.transports ?? [],
  }));
}

export async function hasRegisteredPasskey(): Promise<boolean> {
  return (await loadPasskeys()).length > 0;
}

async function storeChallenge(kind: ChallengeKind, challenge: string): Promise<string> {
  const challengeId = crypto.randomBytes(16).toString("hex");
  await redis.set(
    `${KEY_PREFIX}challenge:${challengeId}`,
    JSON.stringify({ kind, challenge }),
    "EX",
    CHALLENGE_TTL_SECONDS,
  );
  return challengeId;
}

async function takeChallenge(kind: ChallengeKind, challengeId: unknown): Promise<string> {
  if (typeof challengeId !== "string" || !/^[a-f0-9]{32}$/.test(challengeId)) {
    throw new AppError("Invalid challenge", 400, "INVALID_CHALLENGE");
  }
  const key = `${KEY_PREFIX}challenge:${challengeId}`;
  const [[, raw]] = (await redis.multi().get(key).del(key).exec()) as [
    [Error | null, string | null],
    unknown,
  ];
  if (!raw) {
    throw new AppError("Challenge expired, try again", 400, "CHALLENGE_EXPIRED");
  }
  const stored = JSON.parse(raw) as { kind: ChallengeKind; challenge: string };
  if (stored.kind !== kind) {
    throw new AppError("Invalid challenge", 400, "INVALID_CHALLENGE");
  }
  return stored.challenge;
}

export async function assertNotLockedOut(): Promise<void> {
  const failures = Number(await redis.get(`${KEY_PREFIX}failures`)) || 0;
  if (failures >= MAX_FAILURES) {
    throw new AppError("Too many failed attempts, try again later", 429, "LOCKED_OUT");
  }
}

export async function recordFailure(): Promise<void> {
  const key = `${KEY_PREFIX}failures`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, FAILURE_WINDOW_SECONDS);
  }
}

export async function createRegistrationOptions() {
  const { rpID } = getWebAuthnConfig();
  const existing = await loadPasskeys();
  const options = await generateRegistrationOptions({
    rpName: "KnowUsBetter Admin",
    rpID,
    userName: "admin",
    userDisplayName: "KnowUsBetter Admin",
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });
  const challengeId = await storeChallenge("register", options.challenge);
  return { challengeId, options };
}

export async function verifyRegistration(
  challengeId: unknown,
  response: RegistrationResponseJSON,
  label: string | null,
): Promise<void> {
  const expectedChallenge = await takeChallenge("register", challengeId);
  const { rpID, origin } = getWebAuthnConfig();

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new AppError("Passkey registration failed", 401, "REGISTRATION_FAILED");
  }

  const { credential } = verification.registrationInfo;
  await getAdminPool().query(
    `INSERT INTO admin_panel.passkeys (id, public_key, counter, transports, label)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports ?? [],
      label,
    ],
  );
}

export async function createAuthenticationOptions() {
  const { rpID } = getWebAuthnConfig();
  const passkeys = await loadPasskeys();
  if (passkeys.length === 0) {
    throw new AppError("No passkey registered yet", 400, "NO_PASSKEY");
  }
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    userVerification: "required",
  });
  const challengeId = await storeChallenge("authenticate", options.challenge);
  return { challengeId, options };
}

export async function verifyAuthentication(
  challengeId: unknown,
  response: AuthenticationResponseJSON,
): Promise<void> {
  const expectedChallenge = await takeChallenge("authenticate", challengeId);
  const { rpID, origin } = getWebAuthnConfig();
  const passkey = (await loadPasskeys()).find((p) => p.id === response?.id);
  if (!passkey) {
    throw new AppError("Unknown passkey", 401, "UNKNOWN_PASSKEY");
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: passkey,
    requireUserVerification: true,
  });

  if (!verification.verified) {
    throw new AppError("Passkey verification failed", 401, "AUTH_FAILED");
  }

  await getAdminPool().query(
    "UPDATE admin_panel.passkeys SET counter = $2, last_used_at = now() WHERE id = $1",
    [passkey.id, verification.authenticationInfo.newCounter],
  );
}

function sessionKey(token: string): string {
  return `${KEY_PREFIX}session:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

export async function createSession(): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const session: AdminSession = { createdAt: Date.now(), stepUpUntil: null };
  await redis.set(sessionKey(token), JSON.stringify(session), "EX", SESSION_TTL_SECONDS);
  return token;
}

export async function getSession(token: string | undefined): Promise<AdminSession | null> {
  if (!token) return null;
  const raw = await redis.get(sessionKey(token));
  return raw ? (JSON.parse(raw) as AdminSession) : null;
}

async function saveSession(token: string, session: AdminSession): Promise<void> {
  await redis.set(sessionKey(token), JSON.stringify(session), "KEEPTTL");
}

export async function grantStepUp(token: string): Promise<void> {
  const session = await getSession(token);
  if (!session) {
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }
  session.stepUpUntil = Date.now() + STEP_UP_TTL_MS;
  await saveSession(token, session);
}

export async function consumeStepUp(token: string): Promise<boolean> {
  const session = await getSession(token);
  if (!session?.stepUpUntil || session.stepUpUntil < Date.now()) {
    return false;
  }
  session.stepUpUntil = null;
  await saveSession(token, session);
  return true;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) {
    await redis.del(sessionKey(token));
  }
}
