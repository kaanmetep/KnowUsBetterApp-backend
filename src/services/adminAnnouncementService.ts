import { getAdminPool } from "../utils/adminDb.js";
import { AppError } from "../errors/AppError.js";
import { LANGS } from "../languages.js";
const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_URL_LENGTH = 500;
const MAX_PRIORITY = 1000;
// The app hands action_url to Linking.openURL, so a scheme is required.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const BLOCKED_SCHEMES = ["javascript:", "data:", "file:"];

type Translations = Partial<Record<(typeof LANGS)[number], string>>;

export interface AnnouncementInput {
  title: Translations;
  message: Translations;
  is_active: boolean;
  priority: number;
  start_date: string | null;
  end_date: string | null;
  action_url: string | null;
}

function readTranslations(raw: unknown, field: string, max: number): Translations {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(`${field} must be an object`, 400, "VALIDATION_ERROR");
  }
  const result: Translations = {};
  for (const lang of LANGS) {
    const value = (raw as Record<string, unknown>)[lang];
    if (value == null) continue;
    if (typeof value !== "string") {
      throw new AppError(`${field}.${lang} must be a string`, 400, "VALIDATION_ERROR");
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
      throw new AppError(`${field}.${lang} is longer than ${max} characters`, 400, "VALIDATION_ERROR");
    }
    if (trimmed) result[lang] = trimmed;
  }
  return result;
}

function readDate(raw: unknown, field: string): string | null {
  if (raw == null || raw === "") return null;
  const time = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isNaN(time)) {
    throw new AppError(`${field} is not a valid date`, 400, "VALIDATION_ERROR");
  }
  return new Date(time).toISOString();
}

function readActionUrl(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new AppError("action_url must be a string", 400, "VALIDATION_ERROR");
  }
  const url = raw.trim();
  if (!url) return null;
  if (url.length > MAX_URL_LENGTH) {
    throw new AppError("action_url is too long", 400, "VALIDATION_ERROR");
  }
  const lower = url.toLowerCase();
  if (!URL_SCHEME_RE.test(url) || BLOCKED_SCHEMES.some((s) => lower.startsWith(s))) {
    throw new AppError(
      "action_url must start with a scheme like https:// or knowusbetter://",
      400,
      "VALIDATION_ERROR",
    );
  }
  return url;
}

export function validateAnnouncementInput(body: any): AnnouncementInput {
  if (!body || typeof body !== "object") {
    throw new AppError("Invalid payload", 400, "VALIDATION_ERROR");
  }

  const title = readTranslations(body.title, "title", MAX_TITLE_LENGTH);
  const message = readTranslations(body.message, "message", MAX_MESSAGE_LENGTH);
  if (!Object.keys(title).length) {
    throw new AppError("At least one language needs a title", 400, "VALIDATION_ERROR");
  }
  for (const lang of LANGS) {
    if (message[lang] && !title[lang]) {
      throw new AppError(`${lang.toUpperCase()} has a message but no title`, 400, "VALIDATION_ERROR");
    }
  }

  const priority = body.priority == null || body.priority === "" ? 0 : Number(body.priority);
  if (!Number.isInteger(priority) || Math.abs(priority) > MAX_PRIORITY) {
    throw new AppError(
      `priority must be a whole number between -${MAX_PRIORITY} and ${MAX_PRIORITY}`,
      400,
      "VALIDATION_ERROR",
    );
  }

  const start_date = readDate(body.start_date, "start_date");
  const end_date = readDate(body.end_date, "end_date");
  if (start_date && end_date && Date.parse(end_date) <= Date.parse(start_date)) {
    throw new AppError("end_date must be after start_date", 400, "VALIDATION_ERROR");
  }

  return {
    title,
    message,
    is_active: body.is_active !== false,
    priority,
    start_date,
    end_date,
    action_url: readActionUrl(body.action_url),
  };
}

const COLUMNS =
  "id, title, message, is_active, priority, start_date, end_date, action_url, created_at, updated_at";

export async function listAnnouncements() {
  const { rows } = await getAdminPool().query(
    `SELECT ${COLUMNS} FROM announcements ORDER BY priority DESC, created_at DESC`,
  );
  return rows;
}

export async function createAnnouncement(input: AnnouncementInput) {
  const { rows } = await getAdminPool().query(
    `INSERT INTO announcements (title, message, is_active, priority, start_date, end_date, action_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.title,
      input.message,
      input.is_active,
      input.priority,
      input.start_date,
      input.end_date,
      input.action_url,
    ],
  );
  return rows[0];
}

export async function updateAnnouncement(id: string, input: AnnouncementInput) {
  const { rows } = await getAdminPool().query(
    `UPDATE announcements
        SET title = $2, message = $3, is_active = $4, priority = $5,
            start_date = $6, end_date = $7, action_url = $8, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [
      id,
      input.title,
      input.message,
      input.is_active,
      input.priority,
      input.start_date,
      input.end_date,
      input.action_url,
    ],
  );
  if (!rows[0]) {
    throw new AppError("Announcement not found", 404, "NOT_FOUND");
  }
  return rows[0];
}

export async function setAnnouncementActive(id: string, isActive: boolean) {
  const { rows } = await getAdminPool().query(
    `UPDATE announcements SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, isActive],
  );
  if (!rows[0]) {
    throw new AppError("Announcement not found", 404, "NOT_FOUND");
  }
  return rows[0];
}

export async function deleteAnnouncement(id: string): Promise<void> {
  const { rowCount } = await getAdminPool().query("DELETE FROM announcements WHERE id = $1", [id]);
  if (!rowCount) {
    throw new AppError("Announcement not found", 404, "NOT_FOUND");
  }
}
