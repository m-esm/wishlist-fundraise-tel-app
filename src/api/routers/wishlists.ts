import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { products, wishlists } from "../../db/schema";
import { assertCanHaveWishlist } from "../../lib/entitlements";
import { canViewWishlist } from "../../services/access";
import { authedProcedure, router } from "../trpc";
import { badRequest, id, ownedWishlist, readableWishlist } from "./_shared";

/** Client timestamps arrive as ISO strings through superjson's JSON path, so accept both. */
const eventDate = z
  .union([z.date(), z.iso.datetime({ offset: true }), z.iso.datetime()])
  .nullish()
  .transform((v) => (v == null ? v : v instanceof Date ? v : new Date(v)));

const visibility = z.enum(["public", "private"]);
const fields = {
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullish(),
  emoji: z.string().max(8).nullish(),
  visibility,
  eventDate,
};

/** Archived lists are read-only; restore is not offered in v1. */
function assertNotArchived(w: { archivedAt: Date | null }) {
  if (w.archivedAt) throw new TRPCError({ code: "CONFLICT", message: "wishlist is archived" });
}

export const wishlistsRouter = router({
  /** Lists owned by userId (default: me) that the viewer may see, with item counts and totals. */
  list: authedProcedure
    .input(z.object({ userId: id.optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const ownerId = input.userId ?? ctx.user.id;
      const rows = await ctx.db
        .select({
          wishlist: wishlists,
          itemCount: sql<number>`count(${products.id})::int`,
          fundedCount: sql<number>`count(${products.id}) filter (where ${products.status} in ('funded','purchased'))::int`,
        })
        .from(wishlists)
        .leftJoin(products, and(eq(products.wishlistId, wishlists.id), sql`${products.status} <> 'archived'`))
        .where(and(eq(wishlists.ownerId, ownerId), isNull(wishlists.archivedAt)))
        .groupBy(wishlists.id)
        .orderBy(asc(wishlists.position), asc(wishlists.createdAt));
      const visible = [];
      for (const r of rows) if (await canViewWishlist(ctx.db, ctx.user.id, r.wishlist)) visible.push(r);
      return visible;
    }),

  /** One list with its products (archived products only for the owner). */
  get: authedProcedure.input(z.object({ wishlistId: id })).query(async ({ ctx, input }) => {
    const w = await readableWishlist(ctx.db, ctx.user.id, input.wishlistId);
    const isOwner = w.ownerId === ctx.user.id;
    const items = await ctx.db
      .select()
      .from(products)
      .where(and(eq(products.wishlistId, w.id), isOwner ? undefined : sql`${products.status} <> 'archived'`))
      .orderBy(asc(products.position), asc(products.createdAt));
    return { wishlist: w, products: items, isOwner };
  }),

  /** Plan limits apply: FORBIDDEN "plan_limit:public_wishlists" / "plan_limit:private_wishlists". */
  create: authedProcedure
    .input(z.object({ ...fields, visibility: visibility.default("public") }))
    .mutation(async ({ ctx, input }) => {
      await assertCanHaveWishlist(ctx.db, ctx.user.id, input.visibility);
      const [w] = await ctx.db
        .insert(wishlists)
        .values({
          ...input,
          ownerId: ctx.user.id,
          position: sql`coalesce((select max(position) + 1 from wishlists where owner_id = ${ctx.user.id}), 0)`,
        })
        .returning();
      return w!;
    }),

  update: authedProcedure
    .input(z.object({ wishlistId: id, ...z.object(fields).partial().shape }))
    .mutation(async ({ ctx, input: { wishlistId, ...patch } }) => {
      const current = await ownedWishlist(ctx.db, ctx.user.id, wishlistId);
      assertNotArchived(current);
      if (patch.visibility && patch.visibility !== current.visibility) {
        await assertCanHaveWishlist(ctx.db, ctx.user.id, patch.visibility, wishlistId);
      }
      const [w] = await ctx.db.update(wishlists).set(patch).where(eq(wishlists.id, wishlistId)).returning();
      return w!;
    }),

  reorder: authedProcedure
    .input(z.object({ orderedIds: z.array(id).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const owned = await tx
          .select({ id: wishlists.id })
          .from(wishlists)
          .where(and(eq(wishlists.ownerId, ctx.user.id), inArray(wishlists.id, input.orderedIds)));
        if (owned.length !== new Set(input.orderedIds).size) throw badRequest("unknown wishlist id");
        for (const [i, wid] of input.orderedIds.entries()) {
          await tx.update(wishlists).set({ position: i }).where(eq(wishlists.id, wid));
        }
      });
      return { ok: true };
    }),

  /**
   * Soft delete. Lists with contributions keep their history; hard delete is
   * not offered because contributions.product_id is ON DELETE RESTRICT.
   */
  archive: authedProcedure.input(z.object({ wishlistId: id })).mutation(async ({ ctx, input }) => {
    const w = await ownedWishlist(ctx.db, ctx.user.id, input.wishlistId);
    if (!w.archivedAt) {
      await ctx.db.update(wishlists).set({ archivedAt: new Date() }).where(eq(wishlists.id, input.wishlistId));
    }
    return { ok: true };
  }),
});
