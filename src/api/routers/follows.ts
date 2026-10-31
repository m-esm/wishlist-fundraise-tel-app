import { TRPCError } from "@trpc/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { follows, users } from "../../db/schema";
import { respondToFollow } from "../../services/follows";
import { enqueue } from "../../services/outbox";
import { authedProcedure, router } from "../trpc";
import { id, notFound } from "./_shared";

const person = {
  id: users.id,
  username: users.username,
  firstName: users.firstName,
  lastName: users.lastName,
  photoUrl: users.photoUrl,
};

export const followsRouter = router({
  /**
   * Pending by default; the owner gets a DM with Accept/Decline. Accepted
   * at once if the owner turned on autoAcceptFollows. A rejected request
   * stays "rejected" (no repeat DMs), but the caller sees "pending".
   */
  follow: authedProcedure.input(z.object({ userId: id })).mutation(async ({ ctx, input }) => {
    if (input.userId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "cannot follow yourself" });
    const [target] = await ctx.db.select().from(users).where(eq(users.id, input.userId));
    if (!target) throw notFound("user");

    return ctx.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(follows)
        .where(and(eq(follows.followerId, ctx.user.id), eq(follows.followeeId, target.id)));
      if (existing?.status === "accepted") return { status: "accepted" as const };
      if (existing?.status === "rejected") return { status: "pending" as const };
      if (existing?.status === "pending") return { status: "pending" as const };

      const status = target.autoAcceptFollows ? "accepted" : "pending";
      await tx.insert(follows).values({
        followerId: ctx.user.id,
        followeeId: target.id,
        status,
        respondedAt: status === "accepted" ? new Date() : null,
      });
      if (status === "pending") {
        await enqueue(tx, { kind: "follow_request", userId: target.id, payload: { followerId: ctx.user.id } });
      }
      return { status };
    });
  }),

  /**
   * Withdraw my request or stop following. A rejected edge is kept: the owner
   * already said no, and deleting it would let the same request be sent again.
   */
  unfollow: authedProcedure.input(z.object({ userId: id })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(follows).where(and(
      eq(follows.followerId, ctx.user.id),
      eq(follows.followeeId, input.userId),
      ne(follows.status, "rejected"),
    ));
    return { ok: true };
  }),

  /** Answer an incoming request (also reachable from the bot DM buttons). */
  respond: authedProcedure
    .input(z.object({ followerId: id, accept: z.boolean() }))
    .mutation(async ({ ctx, input }) => respondToFollow(ctx.db, ctx.user.id, input.followerId, input.accept)),

  /** Remove someone who follows me. */
  removeFollower: authedProcedure.input(z.object({ followerId: id })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(follows).where(and(eq(follows.followerId, input.followerId), eq(follows.followeeId, ctx.user.id)));
    return { ok: true };
  }),

  incomingRequests: authedProcedure.query(({ ctx }) =>
    ctx.db.select({ user: person, requestedAt: follows.createdAt }).from(follows)
      .innerJoin(users, eq(users.id, follows.followerId))
      .where(and(eq(follows.followeeId, ctx.user.id), eq(follows.status, "pending")))
      .orderBy(desc(follows.createdAt)),
  ),

  /** My followers / who I follow. Other users' graphs are not exposed (counts only, via users.profile). */
  followers: authedProcedure.query(({ ctx }) =>
    ctx.db.select(person).from(follows)
      .innerJoin(users, eq(users.id, follows.followerId))
      .where(and(eq(follows.followeeId, ctx.user.id), eq(follows.status, "accepted")))
      .orderBy(desc(follows.respondedAt)),
  ),

  following: authedProcedure.query(({ ctx }) =>
    ctx.db.select(person).from(follows)
      .innerJoin(users, eq(users.id, follows.followeeId))
      .where(and(eq(follows.followerId, ctx.user.id), eq(follows.status, "accepted")))
      .orderBy(desc(follows.respondedAt)),
  ),
});
