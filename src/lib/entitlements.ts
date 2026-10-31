import { and, count, eq, isNull, ne } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Executor } from "../db/client";
import { products, subscriptions, wishlists } from "../db/schema";

/**
 * Plan limits (user decision on MOSA-39):
 *   free:    1 public + 1 private wishlist, 5 products per wishlist
 *   premium: unlimited
 *
 * Premium price (board decision): €12.50 once, converted to Telegram Stars at
 * checkout with STARS_RATES.EUR. Annual access lasts ANNUAL_DAYS. Lifetime
 * access has no expiry. The first activation can be a TRIAL_DAYS trial with
 * no invoice. There is no /premium bot command.
 *
 * Archived lists and archived products do not count. Going back to free after
 * premium never deletes data: existing items stay readable, only creating new
 * ones over the limit is blocked.
 */

/** First Premium activation, with no Stars invoice. One trial per user. */
export const TRIAL_DAYS = 30;
/** Length of a paid annual Premium term. */
export const ANNUAL_DAYS = 365;
/** €12.50 in euro minor units. Stars are derived at checkout, not stored here. */
export const PREMIUM_PRICE_MINOR = 1250;
export const PREMIUM_PRICE_CURRENCY = "EUR";
export const PLAN_LIMITS = {
  free: { publicWishlists: 1, privateWishlists: 1, productsPerWishlist: 5 },
  premium: { publicWishlists: Infinity, privateWishlists: Infinity, productsPerWishlist: Infinity },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;

export async function planOf(db: Executor, userId: string): Promise<Plan> {
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  if (!s || s.plan !== "premium") return "free";
  return !s.expiresAt || s.expiresAt > new Date() ? "premium" : "free";
}

function limitError(what: string): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message: `plan_limit:${what}` });
}

/** Call before creating a wishlist, or before changing a list's visibility. */
export async function assertCanHaveWishlist(
  db: Executor,
  userId: string,
  visibility: "public" | "private",
  excludeWishlistId?: string,
) {
  const limits = PLAN_LIMITS[await planOf(db, userId)];
  const max = visibility === "public" ? limits.publicWishlists : limits.privateWishlists;
  if (max === Infinity) return;
  const [row] = await db
    .select({ n: count() })
    .from(wishlists)
    .where(and(
      eq(wishlists.ownerId, userId),
      eq(wishlists.visibility, visibility),
      isNull(wishlists.archivedAt),
      excludeWishlistId ? ne(wishlists.id, excludeWishlistId) : undefined,
    ));
  if ((row?.n ?? 0) >= max) throw limitError(`${visibility}_wishlists`);
}

/** Call before adding a product, or before un-archiving one. */
export async function assertCanAddProduct(db: Executor, userId: string, wishlistId: string) {
  const limits = PLAN_LIMITS[await planOf(db, userId)];
  if (limits.productsPerWishlist === Infinity) return;
  const [row] = await db
    .select({ n: count() })
    .from(products)
    .where(and(eq(products.wishlistId, wishlistId), ne(products.status, "archived")));
  if ((row?.n ?? 0) >= limits.productsPerWishlist) throw limitError("products_per_wishlist");
}
