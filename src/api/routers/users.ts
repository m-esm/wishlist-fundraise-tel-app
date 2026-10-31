import { TRPCError } from "@trpc/server";
import { and, count, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { follows, users, wishlists } from "../../db/schema";
import { env } from "../../env";
import { PLAN_LIMITS, planOf } from "../../lib/entitlements";
import { authedProcedure, router } from "../trpc";
import { id, notFound } from "./_shared";

/** ISO-4217 (3 letters, uppercase) or XTR; must have a Stars rate unless XTR. */
const supportedCurrency = z
  .string()
  .regex(/^[A-Z]{3}$/, "ISO-4217 code or XTR")
  .refine((c) => c === "XTR" || Boolean(env.STARS_RATES[c]), "currency is not supported");

const publicUser = {
  id: users.id,
  username: users.username,
  firstName: users.firstName,
  lastName: users.lastName,
  photoUrl: users.photoUrl,
  bio: users.bio,
};

export const usersRouter = router({
  /** Me + plan, so the Mini App can show limits ("1 of 1 public lists used"). */
  me: authedProcedure.query(async ({ ctx }) => {
    const plan = await planOf(ctx.db, ctx.user.id);
    const limits = PLAN_LIMITS[plan];
    const finite = (n: number) => (n === Infinity ? null : n); // JSON has no Infinity
    return {
      user: ctx.user,
      plan,
      limits: {
        publicWishlists: finite(limits.publicWishlists),
        privateWishlists: finite(limits.privateWishlists),
        productsPerWishlist: finite(limits.productsPerWishlist),
      },
    };
  }),

  /** Any plan change (upgrade/downgrade) is not implemented yet: the Stars subscription flow is still an open decision. */
  setPlan: authedProcedure
    .input(z.object({ plan: z.enum(["free", "premium"]) }))
    .mutation(() => {
      throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Premium coming soon" });
    }),

  updateMe: authedProcedure
    .input(
      z.object({
        bio: z.string().max(500).nullish(),
        autoAcceptFollows: z.boolean().optional(),
        notificationsEnabled: z.boolean().optional(),
        defaultCurrency: supportedCurrency.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [u] = await ctx.db.update(users).set(input).where(eq(users.id, ctx.user.id)).returning();
      return u!;
    }),

  /** Profile card + relationship to viewer. */
  profile: authedProcedure
    .input(z.union([z.object({ userId: id }), z.object({ username: z.string().min(1).max(32) })]))
    .query(async ({ ctx, input }) => {
      const where =
        "userId" in input
          ? eq(users.id, input.userId)
          : sql`lower(${users.username}) = lower(${input.username.replace(/^@/, "")})`;
      const [u] = await ctx.db.select(publicUser).from(users).where(where);
      if (!u) throw notFound("user");

      const [[outgoing], [incoming], [followers], [following], [lists]] = await Promise.all([
        ctx.db.select({ s: follows.status }).from(follows)
          .where(and(eq(follows.followerId, ctx.user.id), eq(follows.followeeId, u.id))),
        ctx.db.select({ s: follows.status }).from(follows)
          .where(and(eq(follows.followerId, u.id), eq(follows.followeeId, ctx.user.id))),
        ctx.db.select({ n: count() }).from(follows)
          .where(and(eq(follows.followeeId, u.id), eq(follows.status, "accepted"))),
        ctx.db.select({ n: count() }).from(follows)
          .where(and(eq(follows.followerId, u.id), eq(follows.status, "accepted"))),
        ctx.db.select({ n: count() }).from(wishlists)
          .where(and(eq(wishlists.ownerId, u.id), sql`${wishlists.archivedAt} is null`)),
      ]);
      return {
        user: u,
        isMe: u.id === ctx.user.id,
        // viewer -> user. A rejected request is reported as "pending" so the
        // client cannot reveal that a rejection happened (see follows.follow).
        followStatus: outgoing?.s === "rejected" ? ("pending" as const) : outgoing?.s ?? null,
        followsMe: incoming?.s === "accepted",
        counts: { followers: followers?.n ?? 0, following: following?.n ?? 0, wishlists: lists?.n ?? 0 },
      };
    }),

  /** Username / first-name prefix search. Returns profile cards only; list access is still checked per list. */
  search: authedProcedure
    .input(z.object({ query: z.string().trim().min(2).max(32), limit: z.number().int().max(30).default(15) }))
    .query(({ ctx, input }) => {
      const q = `${input.query.replace(/^@/, "").replace(/[%_\\]/g, "\\$&")}%`;
      return ctx.db
        .select(publicUser)
        .from(users)
        .where(and(
          or(ilike(users.username, q), ilike(users.firstName, q)),
          sql`${users.id} <> ${ctx.user.id}`,
        ))
        .limit(input.limit);
    }),
});
