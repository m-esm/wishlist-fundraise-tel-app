import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { Composer } from "grammy";
import { db } from "../../db/client";
import { groupSessionVotes, groupSessions, products, wishlists } from "../../db/schema";
import { env } from "../../env";
import { ContributionError, decideManual } from "../../services/contributions";
import { respondToFollow } from "../../services/follows";
import { activeSession, canManageSession, closeSession } from "../commands/group";
import type { BotContext } from "../context";
import { renderSession } from "../render";
import { sendSessionInvoice } from "./payments";

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const EXPIRED = "This button has expired.";
export const callbacks = new Composer<BotContext>();

async function refresh(ctx: BotContext, sessionId: string) {
  const r = await renderSession(db, sessionId);
  if (!r) return;
  await ctx.editMessageText(r.text, { parse_mode: "HTML", reply_markup: r.keyboard }).catch(() => {
    /* "message is not modified" or too old to edit */
  });
}

// ------------------------------------------------ DM: follow requests

callbacks.callbackQuery(new RegExp(`^f([ad]):${UUID}$`), async (ctx) => {
  const accept = ctx.match[1] === "a";
  try {
    await respondToFollow(db, ctx.dbUser!.id, ctx.match[2]!, accept);
    await ctx.editMessageText(accept ? "✅ Accepted." : "Declined.");
  } catch (e) {
    if (!(e instanceof TRPCError) || e.code !== "NOT_FOUND") throw e;
    return ctx.answerCallbackQuery({ text: EXPIRED });
  }
  await ctx.answerCallbackQuery();
});

// ------------------------------------------------ DM: manual payment decisions

callbacks.callbackQuery(new RegExp(`^m([cr]):${UUID}$`), async (ctx) => {
  const decision = ctx.match[1] === "c" ? "confirm" : "reject";
  try {
    await decideManual(db, ctx.match[2]!, ctx.dbUser!.id, decision);
    await ctx.editMessageText(decision === "confirm" ? "✅ Confirmed — added to the progress." : "❌ Marked as not received.");
    await ctx.answerCallbackQuery();
  } catch (e) {
    if (!(e instanceof ContributionError)) throw e;
    await ctx.answerCallbackQuery({ text: EXPIRED });
  }
});

// ------------------------------------------------ group: voting

callbacks.callbackQuery(new RegExp(`^gv:${UUID}:(\\d{1,2})$`), async (ctx) => {
  const [s] = await db.select().from(groupSessions).where(eq(groupSessions.id, ctx.match[1]!));
  const productId = s?.candidateProductIds[Number(ctx.match[2]) - 1];
  if (!s || s.telegramChatId !== ctx.chat?.id || s.status !== "voting" || !productId) return ctx.answerCallbackQuery({ text: EXPIRED });
  if (ctx.dbUser!.id === s.beneficiaryId) return ctx.answerCallbackQuery({ text: "No peeking 🙈" });
  await db
    .insert(groupSessionVotes)
    .values({ sessionId: s.id, userId: ctx.dbUser!.id, productId })
    .onConflictDoUpdate({ target: [groupSessionVotes.sessionId, groupSessionVotes.userId], set: { productId } });
  await ctx.answerCallbackQuery({ text: `Voted for #${ctx.match[2]}` });
  await refresh(ctx, s.id);
});

/** Start: highest vote wins. Ties keep list order. Skip wishes that are no longer eligible. */
callbacks.callbackQuery(new RegExp(`^gs:${UUID}$`), async (ctx) => {
  const [s] = await db.select().from(groupSessions).where(eq(groupSessions.id, ctx.match[1]!));
  if (!s || s.telegramChatId !== ctx.chat?.id || s.status !== "voting") return ctx.answerCallbackQuery({ text: EXPIRED });
  if (!(await canManageSession(ctx, s))) {
    return ctx.answerCallbackQuery({ text: "Only the starter or an admin can start it.", show_alert: true });
  }
  const tally = await db
    .select({ productId: groupSessionVotes.productId, n: sql<number>`count(*)::int` })
    .from(groupSessionVotes)
    .where(eq(groupSessionVotes.sessionId, s.id))
    .groupBy(groupSessionVotes.productId);
  const votes = new Map(tally.map((t) => [t.productId, t.n]));
  const ranked = [...s.candidateProductIds].sort((a, b) => (votes.get(b) ?? 0) - (votes.get(a) ?? 0));
  // A wish can become private, archived, or funded while the vote is open.
  const stillOpen = await db.select({ id: products.id }).from(products)
    .innerJoin(wishlists, eq(wishlists.id, products.wishlistId))
    .where(and(inArray(products.id, ranked), eq(products.status, "active"),
      eq(wishlists.ownerId, s.beneficiaryId), eq(wishlists.visibility, "public"),
      sql`${wishlists.archivedAt} is null`));
  const eligible = new Set(stillOpen.map((row) => row.id));
  const winner = ranked.find((id) => eligible.has(id));
  if (!winner) return ctx.answerCallbackQuery({ text: EXPIRED });
  await db
    .update(groupSessions)
    .set({ status: "open", productId: winner })
    .where(and(eq(groupSessions.id, s.id), eq(groupSessions.status, "voting")));
  await ctx.answerCallbackQuery({ text: "Collecting started!" });
  await refresh(ctx, s.id);
});

callbacks.callbackQuery(new RegExp(`^gx:${UUID}$`), async (ctx) => {
  const [s] = await db
    .select()
    .from(groupSessions)
    .where(and(eq(groupSessions.id, ctx.match[1]!), inArray(groupSessions.status, ["voting", "open"])));
  if (!s || s.telegramChatId !== ctx.chat?.id) return ctx.answerCallbackQuery({ text: EXPIRED });
  if (!(await canManageSession(ctx, s))) {
    return ctx.answerCallbackQuery({ text: "Only the starter or an admin can close it.", show_alert: true });
  }
  await closeSession(s);
  await ctx.answerCallbackQuery();
  await refresh(ctx, s.id);
});

// ------------------------------------------------ group: quick Stars buttons

callbacks.callbackQuery(new RegExp(`^gp:${UUID}:(\\d{1,6})$`), async (ctx) => {
  const stars = Number(ctx.match[2]);
  const s = ctx.chat ? await activeSession(ctx.chat.id) : undefined;
  if (!s || s.id !== ctx.match[1] || s.status !== "open" || stars < env.STARS_MIN || stars > env.STARS_MAX) {
    return ctx.answerCallbackQuery({ text: EXPIRED });
  }
  const toDm = await sendSessionInvoice(ctx, s, stars);
  await ctx.answerCallbackQuery({ text: toDm ? "Invoice sent to your DM with the bot ⭐" : "Invoice posted ⭐" });
});

// Unknown/stale buttons: always answer so the client stops spinning.
callbacks.on("callback_query:data", (ctx) => ctx.answerCallbackQuery({ text: "This button has expired." }));
