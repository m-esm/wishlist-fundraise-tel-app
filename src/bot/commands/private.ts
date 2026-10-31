import { and, eq, sql } from "drizzle-orm";
import { Composer, InlineKeyboard } from "grammy";
import { db } from "../../db/client";
import { contributions, follows, products, users, wishlists } from "../../db/schema";
import { formatMoney } from "../../lib/money";
import { miniAppLink, parseStartParam } from "../../lib/telegram";
import type { BotContext } from "../context";
import { cb, displayName, esc } from "../render";

/** Commands available in the bot DM. The Mini App does the heavy lifting; these are shortcuts. */
export const privateCommands = new Composer<BotContext>();
const cmd = privateCommands.chatType("private");

const openApp = (label: string, param?: string) => new InlineKeyboard().url(label, miniAppLink(param));

/**
 * /start [param]
 *   (none) welcome + open app
 *   u_<id> / w_<id> / p_<id> / s_<id>  deep link from a shared card -> open app there
 * Starting the bot also enables DMs (users.can_dm), set in bot.ts middleware.
 */
cmd.command("start", async (ctx) => {
  const param = parseStartParam(ctx.match);
  if (param?.kind === "premium") {
    return ctx.reply("Review Premium in the app. There is no separate command for it.", {
      reply_markup: openApp("Review Premium", "premium"),
    });
  }
  if (param) {
    return ctx.reply("Tap to open:", { reply_markup: openApp("🎁 Open", ctx.match) });
  }
  await ctx.reply(
    [
      `Hi ${esc(ctx.from.first_name)}! 🎁`,
      "",
      "Make wishlists, share them with friends, and collect gifts — alone or as a group.",
      "• Add the bot to a group and type /fundraise @friend to gift together",
      "• Type @" + ctx.me.username + " in any chat to share your lists",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: openApp("🎁 Open my wishlists") },
  );
});

cmd.command("app", (ctx) => ctx.reply("Your wishlists:", { reply_markup: openApp("🎁 Open app") }));

/** /mylists — quick text overview with progress. */
cmd.command("mylists", async (ctx) => {
  const rows = await db
    .select({
      id: wishlists.id,
      title: wishlists.title,
      items: sql<number>`count(${products.id})::int`,
      funded: sql<number>`count(${products.id}) filter (where ${products.status} in ('funded','purchased'))::int`,
    })
    .from(wishlists)
    .leftJoin(products, and(eq(products.wishlistId, wishlists.id), sql`${products.status} <> 'archived'`))
    .where(and(eq(wishlists.ownerId, ctx.dbUser!.id), sql`${wishlists.archivedAt} is null`))
    .groupBy(wishlists.id)
    .orderBy(wishlists.position);
  if (rows.length === 0) return ctx.reply("No wishlists yet.", { reply_markup: openApp("➕ Create one") });
  const kb = new InlineKeyboard();
  for (const r of rows) kb.url(`${r.title} (${r.funded}/${r.items})`, miniAppLink(`w_${r.id}`)).row();
  await ctx.reply("Your wishlists (funded / items):", { reply_markup: kb });
});

/** /requests — pending follow requests with Accept/Decline buttons. */
cmd.command("requests", async (ctx) => {
  const rows = await db
    .select({ id: users.id, username: users.username, firstName: users.firstName })
    .from(follows)
    .innerJoin(users, eq(users.id, follows.followerId))
    .where(and(eq(follows.followeeId, ctx.dbUser!.id), eq(follows.status, "pending")))
    .limit(20);
  if (rows.length === 0) return ctx.reply("No pending follow requests.");
  for (const u of rows) {
    await ctx.reply(`${esc(displayName(u))} wants to follow you.`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("✅ Accept", cb.followAccept(u.id)).text("❌ Decline", cb.followDecline(u.id)),
    });
  }
});

/** /pending — manual payment claims awaiting my confirmation. */
cmd.command("pending", async (ctx) => {
  const rows = await db
    .select({ c: contributions, title: products.title, who: { username: users.username, firstName: users.firstName } })
    .from(contributions)
    .innerJoin(products, eq(products.id, contributions.productId))
    .innerJoin(wishlists, eq(wishlists.id, products.wishlistId))
    .innerJoin(users, eq(users.id, contributions.contributorId))
    .where(and(eq(wishlists.ownerId, ctx.dbUser!.id), eq(contributions.status, "awaiting_confirmation")))
    .limit(20);
  if (rows.length === 0) return ctx.reply("Nothing waiting for your confirmation.");
  for (const r of rows) await ctx.reply(...manualClaimMessage(r.c.id, r.c.isAnonymous ? "Someone (anonymous)" : displayName(r.who), r.title, formatMoney(r.c.amountMinor, r.c.currency), r.c.message));
});

export function manualClaimMessage(id: string, who: string, title: string, amount: string, note: string | null) {
  return [
    `💸 ${esc(who)} says they sent you <b>${esc(amount)}</b> for <b>${esc(title)}</b>.` +
      (note ? `\n“${esc(note)}”` : "") +
      "\n\nDid you receive it?",
    {
      parse_mode: "HTML" as const,
      reply_markup: new InlineKeyboard().text("✅ Received", cb.manualConfirm(id)).text("❌ Not received", cb.manualReject(id)),
    },
  ] as const;
}

/** /settings — toggle DM notifications. */
cmd.command("settings", async (ctx) => {
  const arg = ctx.match.trim().toLowerCase();
  if (arg === "on" || arg === "off") {
    await db.update(users).set({ notificationsEnabled: arg === "on" }).where(eq(users.id, ctx.dbUser!.id));
    return ctx.reply(`Notifications ${arg}.`);
  }
  await ctx.reply(
    `Notifications are ${ctx.dbUser!.notificationsEnabled ? "on" : "off"}. Use /settings on or /settings off.\nPrivacy and profile settings are in the app.`,
    { reply_markup: openApp("⚙️ Open settings") },
  );
});

cmd.command("help", (ctx) =>
  ctx.reply(
    [
      "/app — open the Mini App",
      "/mylists — your wishlists",
      "/requests — follow requests",
      "/pending — payments to confirm",
      "/settings on|off — DM notifications",
      "/paysupport — help with a Stars payment",
      "/terms — terms of service",
      "",
      "In groups: /fundraise @user, /status, /contribute, /close",
    ].join("\n"),
  ),
);

cmd.command("terms", (ctx) =>
  ctx.reply(
    "Contributions in Telegram Stars are voluntary gifts toward another user's wish. " +
      "Manual payments happen outside Telegram; we only record them. See the app for full terms.",
  ),
);
