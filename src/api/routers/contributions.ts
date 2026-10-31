import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { contributions, groupSessions, products, users, wishlists } from "../../db/schema";
import { env } from "../../env";
import { formatMoney, STARS, starsToMinor } from "../../lib/money";
import { tg } from "../../lib/telegram";
import { ContributionError, decideManual, invoicePayload } from "../../services/contributions";
import { enqueue } from "../../services/outbox";
import { authedProcedure, router } from "../trpc";
import { id, money, notFound, page, parseCursor, readableProduct } from "./_shared";

const extras = {
  message: z.string().trim().max(280).nullish(),
  isAnonymous: z.boolean().default(false),
  /** Set when the Mini App was opened from a group session link (s_<id>). */
  groupSessionId: id.nullish(),
};

/** Product must be collecting, viewer must not be the owner, session (if any) must be open for it. */
async function contributable(db: Parameters<typeof readableProduct>[0], viewerId: string, productId: string, sessionId?: string | null) {
  const row = await readableProduct(db, viewerId, productId).catch(async (e) => {
    // Group-session links let any member contribute to a public product they cannot otherwise browse.
    if (!sessionId) throw e;
    return publicProduct(db, productId);
  });
  if (row.wishlist.ownerId === viewerId) throw new TRPCError({ code: "BAD_REQUEST", message: "cannot contribute to your own wish" });
  if (row.product.status !== "active") throw new TRPCError({ code: "CONFLICT", message: "this wish is not collecting" });
  if (row.product.currency !== STARS && !env.STARS_RATES[row.product.currency]) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `currency ${row.product.currency} is not supported` });
  }
  if (sessionId) {
    const [s] = await db.select().from(groupSessions).where(eq(groupSessions.id, sessionId));
    if (!s || s.status !== "open" || s.productId !== productId) throw notFound("open group session");
  }
  return row;
}

/** Public lists are visible to any member of a group session, so the session link must not widen access. */
async function publicProduct(db: Parameters<typeof readableProduct>[0], productId: string) {
  const [r] = await db.select({ product: products, wishlist: wishlists }).from(products)
    .innerJoin(wishlists, eq(wishlists.id, products.wishlistId)).where(eq(products.id, productId));
  if (!r || r.wishlist.visibility !== "public" || r.wishlist.archivedAt) throw notFound("product");
  return r;
}

const contributorView = {
  id: contributions.id,
  productId: contributions.productId,
  method: contributions.method,
  status: contributions.status,
  amountMinor: contributions.amountMinor,
  currency: contributions.currency,
  starsAmount: contributions.starsAmount,
  message: contributions.message,
  isAnonymous: contributions.isAnonymous,
  groupSessionId: contributions.groupSessionId,
  createdAt: contributions.createdAt,
  confirmedAt: contributions.confirmedAt,
  contributor: { id: users.id, username: users.username, firstName: users.firstName, photoUrl: users.photoUrl },
};

export const contributionsRouter = router({
  /** How much a Stars amount credits, and Stars needed to finish the goal. */
  quote: authedProcedure
    .input(z.object({ productId: id, stars: z.number().int().min(env.STARS_MIN).max(env.STARS_MAX) }))
    .query(async ({ ctx, input }) => {
      const { product } = await readableProduct(ctx.db, ctx.user.id, input.productId);
      const { amountMinor } = starsToMinor(input.stars, product.currency);
      const remaining = Math.max(0, product.priceMinor - product.fundedMinor);
      const rate = product.currency === STARS ? 1 : env.STARS_RATES[product.currency]!;
      return {
        amountMinor,
        formatted: formatMoney(amountMinor, product.currency),
        starsToComplete: Math.min(env.STARS_MAX, Math.ceil(remaining / rate)),
      };
    }),

  /**
   * Stars contribution from the Mini App. Creates a pending row and returns an
   * invoice link; the client calls Telegram.WebApp.openInvoice(link). The row
   * is confirmed by the bot on successful_payment (never by the client).
   */
  createStarsInvoice: authedProcedure
    .input(z.object({ productId: id, stars: z.number().int().min(env.STARS_MIN).max(env.STARS_MAX), ...extras }))
    .mutation(async ({ ctx, input }) => {
      const { product } = await contributable(ctx.db, ctx.user.id, input.productId, input.groupSessionId);
      const { amountMinor, rate } = starsToMinor(input.stars, product.currency);
      const [c] = await ctx.db.insert(contributions).values({
        productId: product.id,
        contributorId: ctx.user.id,
        groupSessionId: input.groupSessionId ?? null,
        method: "stars",
        status: "pending",
        amountMinor: Math.max(1, amountMinor),
        currency: product.currency,
        starsAmount: input.stars,
        starsRate: rate,
        message: input.message ?? null,
        isAnonymous: input.isAnonymous,
      }).returning();
      const invoiceLink = await tg.createInvoiceLink(
        `Gift: ${product.title}`.slice(0, 32),
        `Chip in toward "${product.title}"`.slice(0, 255),
        invoicePayload.forContribution(c!.id),
        "", // provider_token: empty for Telegram Stars
        STARS,
        [{ label: "Contribution", amount: input.stars }],
        { photo_url: product.imageUrl ?? undefined },
      );
      return { contributionId: c!.id, invoiceLink };
    }),

  /** "I paid you outside Telegram" — owner must confirm before it counts. */
  declareManual: authedProcedure
    .input(z.object({ productId: id, amountMinor: money, ...extras }))
    .mutation(async ({ ctx, input }) => {
      const { product, wishlist } = await contributable(ctx.db, ctx.user.id, input.productId, input.groupSessionId);
      const [open] = await ctx.db.select({ n: count() }).from(contributions).where(and(
        eq(contributions.contributorId, ctx.user.id),
        eq(contributions.productId, product.id),
        eq(contributions.status, "awaiting_confirmation"),
      ));
      if ((open?.n ?? 0) >= 3) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "wait for the owner to confirm your earlier claims" });

      return ctx.db.transaction(async (tx) => {
        const [c] = await tx.insert(contributions).values({
          productId: product.id,
          contributorId: ctx.user.id,
          groupSessionId: input.groupSessionId ?? null,
          method: "manual",
          status: "awaiting_confirmation",
          amountMinor: input.amountMinor,
          currency: product.currency,
          message: input.message ?? null,
          isAnonymous: input.isAnonymous,
        }).returning();
        await enqueue(tx, { kind: "manual_claim", userId: wishlist.ownerId, payload: { contributionId: c!.id } });
        return c!;
      });
    }),

  /** Owner confirms/rejects a manual claim (also via bot DM buttons). */
  decide: authedProcedure
    .input(z.object({ contributionId: id, decision: z.enum(["confirm", "reject"]) }))
    .mutation(({ ctx, input }) => decideManual(ctx.db, input.contributionId, ctx.user.id, input.decision)),

  /** Contributor withdraws an unpaid invoice or an undecided manual claim. */
  cancel: authedProcedure.input(z.object({ contributionId: id })).mutation(async ({ ctx, input }) => {
    const [c] = await ctx.db.update(contributions).set({ status: "cancelled" }).where(and(
      eq(contributions.id, input.contributionId),
      eq(contributions.contributorId, ctx.user.id),
      inArray(contributions.status, ["pending", "awaiting_confirmation"]),
    )).returning();
    if (c) return c;
    // Not cancellable: distinguish "not yours / no such row" from a settled state.
    const [row] = await ctx.db.select({ contributorId: contributions.contributorId, status: contributions.status })
      .from(contributions).where(eq(contributions.id, input.contributionId));
    if (!row || row.contributorId !== ctx.user.id) throw new ContributionError("contribution not found");
    throw new TRPCError({ code: "CONFLICT", message: `cannot cancel a ${row.status} contribution` });
  }),

  /**
   * Contribution feed for a product. Everyone sees confirmed ones; the owner
   * also sees awaiting_confirmation. Anonymous contributors are masked for
   * everyone except themselves, the owner included.
   */
  listForProduct: authedProcedure
    .input(page.extend({ productId: id }))
    .query(async ({ ctx, input }) => {
      const { wishlist } = await readableProduct(ctx.db, ctx.user.id, input.productId);
      const statuses = wishlist.ownerId === ctx.user.id ? ["confirmed", "awaiting_confirmation"] as const : ["confirmed"] as const;
      const cursor = parseCursor(input.cursor);
      const rows = await ctx.db.select(contributorView).from(contributions)
        .innerJoin(users, eq(users.id, contributions.contributorId))
        .where(and(
          eq(contributions.productId, input.productId),
          inArray(contributions.status, [...statuses]),
          cursor ? lt(contributions.createdAt, cursor) : undefined,
        ))
        .orderBy(desc(contributions.createdAt))
        .limit(input.limit + 1);
      const items = rows.slice(0, input.limit).map((r) =>
        r.isAnonymous && r.contributor.id !== ctx.user.id ? { ...r, contributor: null } : r);
      return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.createdAt.toISOString() : null };
    }),

  /** Contributions I made. */
  mine: authedProcedure.input(page).query(async ({ ctx, input }) => {
    const cursor = parseCursor(input.cursor);
    const rows = await ctx.db.select({ c: contributions, productTitle: products.title }).from(contributions)
      .innerJoin(products, eq(products.id, contributions.productId))
      .where(and(
        eq(contributions.contributorId, ctx.user.id),
        cursor ? lt(contributions.createdAt, cursor) : undefined,
      ))
      .orderBy(desc(contributions.createdAt))
      .limit(input.limit + 1);
    const items = rows.slice(0, input.limit);
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.c.createdAt.toISOString() : null };
  }),

  /**
   * Manual claims waiting for my decision (badge count in the Mini App).
   * Anonymous claims stay masked even here: the owner verifies by amount,
   * date and note. The contributor id is kept in the DB for audit only.
   */
  awaitingMyDecision: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select({ ...contributorView, productTitle: products.title }).from(contributions)
      .innerJoin(products, eq(products.id, contributions.productId))
      .innerJoin(wishlists, eq(wishlists.id, products.wishlistId))
      .innerJoin(users, eq(users.id, contributions.contributorId))
      .where(and(eq(wishlists.ownerId, ctx.user.id), eq(contributions.status, "awaiting_confirmation")))
      .orderBy(desc(contributions.createdAt));
    return rows.map((r) => (r.isAnonymous ? { ...r, contributor: null } : r));
  }),
});
