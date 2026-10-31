import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { contributions, groupSessions, products, telegramChats, users } from "../../db/schema";
import { authedProcedure, router } from "../trpc";
import { id, notFound } from "./_shared";

/**
 * Group sessions are created and driven from the group chat by the bot
 * (/fundraise, voting buttons, /close). The Mini App only reads them, and
 * contributes through contributions.* with groupSessionId set, when opened
 * via the session link t.me/<bot>/<app>?startapp=s_<sessionId>.
 */
export const groupSessionsRouter = router({
  get: authedProcedure.input(z.object({ sessionId: id })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select({
        session: groupSessions,
        chatTitle: telegramChats.title,
        product: products,
        beneficiary: { id: users.id, username: users.username, firstName: users.firstName, photoUrl: users.photoUrl },
      })
      .from(groupSessions)
      .innerJoin(telegramChats, eq(telegramChats.chatId, groupSessions.telegramChatId))
      .innerJoin(users, eq(users.id, groupSessions.beneficiaryId))
      .leftJoin(products, eq(products.id, groupSessions.productId))
      .where(eq(groupSessions.id, input.sessionId));
    if (!row) throw notFound("group session");
    return row;
  }),

  /**
   * Per-session leaderboard (anonymous contributors grouped as one masked row).
   * Voting sessions show a preview that only the starter or the beneficiary
   * can read. An unknown session id is NOT_FOUND.
   */
  leaderboard: authedProcedure.input(z.object({ sessionId: id })).query(async ({ ctx, input }) => {
    const [s] = await ctx.db.select().from(groupSessions).where(eq(groupSessions.id, input.sessionId));
    if (!s) throw notFound("group session");
    const mayBrowse = s.status !== "voting" || s.beneficiaryId === ctx.user.id || s.createdById === ctx.user.id;
    if (!mayBrowse) throw notFound("group session");
    return ctx.db
      .select({
        userId: sql<string | null>`case when ${contributions.isAnonymous} then null else ${users.id} end`,
        name: sql<string>`case when ${contributions.isAnonymous} then 'Anonymous' else coalesce('@' || ${users.username}, ${users.firstName}) end`,
        totalMinor: sql<number>`sum(${contributions.amountMinor})::bigint`,
      })
      .from(contributions)
      .innerJoin(users, eq(users.id, contributions.contributorId))
      .where(and(eq(contributions.groupSessionId, input.sessionId), eq(contributions.status, "confirmed")))
      .groupBy(sql`1`, sql`2`)
      .orderBy(desc(sql`3`))
      .limit(20);
  }),

  /** Sessions raising money for me (shown on my profile; I can watch progress). */
  forMe: authedProcedure.query(({ ctx }) =>
    ctx.db.select({ session: groupSessions, chatTitle: telegramChats.title, productTitle: products.title })
      .from(groupSessions)
      .innerJoin(telegramChats, eq(telegramChats.chatId, groupSessions.telegramChatId))
      .leftJoin(products, eq(products.id, groupSessions.productId))
      .where(and(eq(groupSessions.beneficiaryId, ctx.user.id), inArray(groupSessions.status, ["voting", "open", "completed"])))
      .orderBy(desc(groupSessions.createdAt)),
  ),
});
