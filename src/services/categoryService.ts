import { SupabaseClient } from "@supabase/supabase-js";
import { GameMode } from "../types.js";

export type { GameMode };

const GAME_MODES: readonly GameMode[] = [
  "see_your_match",
  "know_each_other",
  "who_knows_better",
];

export interface CategoryRecord {
  id: string;
  labels: Record<string, string>;
  groupId: string | null;
  color: string;
  iconName: string;
  iconType: string;
  coinsRequired: number;
  isPremium: boolean;
  recentlyAdded: boolean;
  difficulty: "hard" | null;
  orderIndex: number;
  isListed: boolean;
}

export interface CategoryGroupRecord {
  id: string;
  labels: Record<string, string>;
  orderIndex: number;
  iconName: string;
  iconType: string;
}

interface CategoryCatalog {
  categories: CategoryRecord[];
  groups: CategoryGroupRecord[];
}

const CATALOG_CACHE_TTL_MS = 60_000;

let cached: { catalog: CategoryCatalog; expiresAt: number } | null = null;
let inflight: Promise<CategoryCatalog> | null = null;

const isGameMode = (value: unknown): value is GameMode =>
  typeof value === "string" && (GAME_MODES as readonly string[]).includes(value);

async function loadCatalog(supabaseAdmin: SupabaseClient): Promise<CategoryCatalog> {
  const [categoriesResult, groupsResult] = await Promise.all([
    supabaseAdmin
      .from("categories")
      .select("*")
      .order("order_index", { ascending: true }),
    supabaseAdmin
      .from("category_groups")
      .select("*")
      .order("order_index", { ascending: true }),
  ]);

  if (categoriesResult.error) throw categoriesResult.error;
  if (groupsResult.error) throw groupsResult.error;

  const categories: CategoryRecord[] = (categoriesResult.data ?? []).map((row: any) => ({
    id: row.id,
    labels: row.labels ?? {},
    groupId: row.group_id ?? null,
    color: row.color,
    iconName: row.icon_name,
    iconType: row.icon_type,
    coinsRequired: row.coins_required ?? 0,
    isPremium: row.is_premium ?? false,
    recentlyAdded: row.recently_added ?? false,
    difficulty: row.difficulty === "hard" ? "hard" : null,
    orderIndex: row.order_index ?? 0,
    isListed: row.is_listed !== false,
  }));

  const groups: CategoryGroupRecord[] = (groupsResult.data ?? []).map(
    (row: any) => ({
      id: row.id,
      labels: row.labels ?? {},
      orderIndex: row.order_index ?? 0,
      iconName: row.icon_name || "albums-outline",
      iconType: row.icon_type || "Ionicons",
    }),
  );

  return { categories, groups };
}

export async function getCategoryCatalog(
  supabaseAdmin: SupabaseClient,
): Promise<CategoryCatalog> {
  if (cached && cached.expiresAt > Date.now()) return cached.catalog;
  if (!inflight) {
    inflight = loadCatalog(supabaseAdmin)
      .then((catalog) => {
        cached = { catalog, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS };
        return catalog;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function getCategory(
  categoryId: string,
  supabaseAdmin: SupabaseClient | null,
): Promise<CategoryRecord | null> {
  if (!supabaseAdmin || !categoryId) return null;
  const { categories } = await getCategoryCatalog(supabaseAdmin);
  return categories.find((category) => category.id === categoryId) ?? null;
}

/** A category's group is its game mode. */
export async function getCategoryMode(
  categoryId: string,
  supabaseAdmin: SupabaseClient | null,
): Promise<GameMode> {
  try {
    const groupId = (await getCategory(categoryId, supabaseAdmin))?.groupId;
    return isGameMode(groupId) ? groupId : "see_your_match";
  } catch (error) {
    console.warn("⚠️ Could not resolve category mode:", error);
    return "see_your_match";
  }
}
