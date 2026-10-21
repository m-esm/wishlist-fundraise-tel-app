import { autoRetry } from "@grammyjs/auto-retry";
import { eq } from "drizzle-orm";
import { Bot, BotError, webhookCallback } from "grammy";
import { db } from "../db/client";
import { users } from "../db/schema";
import { env } from "../env";
import { upsertTelegramUser } from "../services/users";
import { groupCommands } from "./commands/group";
import { privateCommands } from "./commands/private";
import type { BotContext } from "./context";
import { callbacks } from "./handlers/callbacks";
import { inline } from "./handlers/inline";
import { membership } from "./handlers/membership";
import { payments } from "./handlers/payments";

export function createBot() {
  const bot = new Bot<BotContext>(env.BOT_TOKEN);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  // Resolve the acting user for every update that has one.
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      ctx.dbUser = await upsertTelegramUser(db, ctx.from);
      // Any private message means the user has started the bot and can be DMed.
      if (ctx.chat?.type === "private" && ctx.message && !ctx.dbUser.canDm) {
        await db.update(users).set({ canDm: true }).where(eq(users.id, ctx.dbUser.id));
        ctx.dbUser.canDm = true;
      }
    }
    await next();
  });

  // Order matters: payments first (pre_checkout has a 10 s deadline).
  bot.use(payments, membership, privateCommands, groupCommands, inline, callbacks);

  bot.catch((err) => {
    console.error(`update ${err.ctx.update.update_id} failed:`, err.error);
    // Log only. Polling calls this handler, and a rethrow ends bot.start().
    // Webhook updates do not use this handler. handleUpdate throws on its own,
    // and createWebhookHandler turns that into HTTP 500 so Telegram redelivers.
  });
  return bot;
}

/**
 * Secret-token check plus update dispatch.
 * A bad secret is 401. A handler failure is 500 so Telegram redelivers the payment.
 */
export function createWebhookHandler(bot: Bot<BotContext>, secretToken: string | undefined) {
  const handle = webhookCallback(bot, "std/http", { secretToken, timeoutMilliseconds: 9_000 });
  return async (req: Request): Promise<Response> => {
    try {
      return await handle(req);
    } catch (err) {
      const updateId = err instanceof BotError ? err.ctx.update.update_id : "?";
      const cause = err instanceof BotError ? err.error : err;
      const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      console.error(`webhook update ${updateId} failed: ${detail}`);
      return new Response("error", { status: 500 });
    }
  };
}

/** Command menus per scope (shown in the Telegram "/" picker). */
export async function registerCommands(bot: Bot<BotContext>) {
  await bot.api.setMyCommands(
    [
      { command: "start", description: "Welcome and open wishlists" },
      { command: "terms", description: "Terms of service" },
      { command: "app", description: "Open my wishlists" },
      { command: "mylists", description: "List my wishlists" },
      { command: "requests", description: "Follow requests" },
      { command: "pending", description: "Payments to confirm" },
      { command: "settings", description: "Notification settings" },
      { command: "paysupport", description: "Help with a Stars payment" },
      { command: "help", description: "How it works" },
    ],
    { scope: { type: "all_private_chats" } },
  );
  await bot.api.setMyCommands(
    [
      { command: "fundraise", description: "Start a group gift: /fundraise @user" },
      { command: "status", description: "Show group gift progress" },
      { command: "contribute", description: "Chip in Stars: /contribute 100" },
      { command: "close", description: "Close the group gift" },
      { command: "cancel", description: "Cancel or close the group gift" },
      { command: "help", description: "How group gifts work" },
    ],
    { scope: { type: "all_group_chats" } },
  );
}
