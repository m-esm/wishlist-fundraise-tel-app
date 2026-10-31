import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../../db/client";
import { products, wishlists } from "../../db/schema";
import { canViewWishlist } from "../../services/access";

export const id = z.uuid();
export const currency = z.string().regex(/^[A-Z]{3}$/, "ISO-4217 code or XTR");
export const money = z.number().int().positive().max(1_000_000_000_00);
export const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);
export const page = z.object({
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().nullish(), // opaque: ISO timestamp of last row's created_at
});

export const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

export function badRequest(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message });
}

/** Keyset pagination cursor: the ISO created_at of the last row of the previous page. */
export function parseCursor(cursor: string | null | undefined): Date | undefined {
  if (!cursor) return undefined;
  const d = new Date(cursor);
  if (Number.isNaN(d.getTime())) throw badRequest("invalid cursor");
  return d;
}

/** Wishlist the viewer may read; NOT_FOUND (not FORBIDDEN) to avoid leaking existence. */
export async function readableWishlist(db: Executor, viewerId: string, wishlistId: string) {
  const [w] = await db.select().from(wishlists).where(eq(wishlists.id, wishlistId));
  if (!w || !(await canViewWishlist(db, viewerId, w))) throw notFound("wishlist");
  return w;
}

export async function ownedWishlist(db: Executor, ownerId: string, wishlistId: string) {
  const [w] = await db.select().from(wishlists).where(eq(wishlists.id, wishlistId));
  if (!w || w.ownerId !== ownerId) throw notFound("wishlist");
  return w;
}

export async function readableProduct(db: Executor, viewerId: string, productId: string) {
  const [row] = await db
    .select({ product: products, wishlist: wishlists })
    .from(products)
    .innerJoin(wishlists, eq(wishlists.id, products.wishlistId))
    .where(eq(products.id, productId));
  if (!row || !(await canViewWishlist(db, viewerId, row.wishlist))) throw notFound("product");
  return row;
}

/** Product row without visibility checks (still owner-guarded by callers). */
export async function anyProduct(db: Executor, productId: string) {
  const [row] = await db
    .select({ product: products, wishlist: wishlists })
    .from(products)
    .innerJoin(wishlists, eq(wishlists.id, products.wishlistId))
    .where(eq(products.id, productId));
  if (!row) throw notFound("product");
  return row;
}

export async function ownedProduct(db: Executor, ownerId: string, productId: string) {
  const row = await anyProduct(db, productId);
  if (row.wishlist.ownerId !== ownerId) throw notFound("product");
  return row;
}
