import { beforeEach, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Update, UserFromGetMe } from "grammy/types";
import { testDb } from "../test/pglite";
import { contributions, follows, groupSessions, groupSessionVotes, notificationOutbox, products, subscriptionPayments, subscriptions, users, wishlists } from "../db/schema";
import { enqueue } from "../services/outbox";

// Only the database boundary is replaced. Handlers, services, transactions,
// migrations, and grammY update dispatch all run normally; Telegram stays offline.
const db = await testDb();
mock.module("../db/client", () => ({ db }));
const { createBot, createWebhookHandler, registerCommands } = await import("./bot");
const { processOutboxBatch } = await import("./notifications/worker");
const me: UserFromGetMe = { id: 999, is_bot: true, first_name: "Wishlist", username: "wishlist_test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: true, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
type Call = { method: string; payload: any };
let calls: Call[];
let bot: ReturnType<typeof createBot>;
let failure: { code: number; retryAfter?: number } | undefined;
let owner: typeof users.$inferSelect;
let friend: typeof users.$inferSelect;
let product: typeof products.$inferSelect;
let sequence = 0;

beforeEach(async () => {
  await db.execute(sql`truncate users, telegram_chats, notification_outbox restart identity cascade`);
  [owner] = await db.insert(users).values({ telegramId: 1, firstName: "Owner", username: "owner", canDm: true }).returning() as [typeof owner];
  [friend] = await db.insert(users).values({ telegramId: 2, firstName: "Friend", username: "friend", canDm: true }).returning() as [typeof friend];
  const [w] = await db.insert(wishlists).values({ ownerId: owner.id, title: "Birthday" }).returning();
  [product] = await db.insert(products).values({ wishlistId: w!.id, title: "Headphones <3", priceMinor: 1000, currency: "USD" }).returning() as [typeof product];
  bot = createBot();
  bot.botInfo = me;
  calls = [];
  failure = undefined;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (failure && ["sendMessage", "editMessageText"].includes(method)) {
      return { ok: false, error_code: failure.code, description: "test failure", parameters: { retry_after: failure.retryAfter } } as any;
    }
    if (method === "getChatMember") return { ok: true, result: { status: "member", user: me } } as any;
    return { ok: true, result: method === "sendMessage" || method === "sendInvoice" ? { message_id: ++sequence, date: 1, chat: { id: (payload as any).chat_id, type: "private" } } : true } as any;
  });
});

const person = (id = 2) => ({ id, is_bot: false, first_name: id === 1 ? "Owner" : "Friend", username: id === 1 ? "owner" : "friend" });
const chat = (id = -10) => id > 0 ? { id, type: "private", first_name: "Friend" } : { id, type: "supergroup", title: "Friends" };
async function command(text: string, chatId = -10, from = 2) {
  await bot.handleUpdate({ update_id: ++sequence, message: { message_id: sequence, date: 1, chat: chat(chatId), from: person(from), text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } } as Update);
}
async function callback(data: string, from = 2, chatId = -10) {
  await bot.handleUpdate({ update_id: ++sequence, callback_query: { id: String(sequence), from: person(from), chat_instance: "test", data, message: { message_id: 77, date: 1, chat: chat(chatId), from: me } } } as Update);
}
const last = (method: string) => calls.filter(c => c.method === method).at(-1)!.payload;
const session = async () => (await db.select().from(groupSessions))[0]!;
async function due() {
  await db.update(notificationOutbox).set({ nextAttemptAt: new Date(0) });
}
async function payment(sessionId: string, charge: string, stars: number) {
  await bot.handleUpdate({ update_id: ++sequence, message: { message_id: sequence, date: 1, chat: chat(-10), from: person(), successful_payment: { currency: "XTR", total_amount: stars, invoice_payload: `s:${sessionId}`, telegram_payment_charge_id: charge, provider_payment_charge_id: "" } } } as Update);
}

test("command menus include the full spec and no premium command; DM commands dispatch", async () => {
  await registerCommands(bot);
  const menus = calls.filter(c => c.method === "setMyCommands");
  expect(menus[0]!.payload.commands.map((c: any) => c.command).sort()).toEqual(["start", "app", "mylists", "requests", "pending", "settings", "paysupport", "terms", "help"].sort());
  expect(menus[1]!.payload.commands.map((c: any) => c.command).sort()).toEqual(["fundraise", "status", "contribute", "close", "cancel", "help"].sort());
  for (const name of ["start", "app", "mylists", "requests", "pending", "settings off", "terms", "help", "paysupport date amount problem"]) {
    await command(`/${name}`, 2);
  }
  expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(9);
  const [u] = await db.select().from(users).where(eq(users.id, friend.id));
  expect(u!.notificationsEnabled).toBe(false);
});

test("vote → start → invoice → confirmed progress → completed, with idempotent payment and refund", async () => {
  await command("/fundraise @owner");
  const s = await session();
  expect(s.status).toBe("voting");
  await callback(`gv:${s.id}:1`, 1);
  expect(await db.select().from(groupSessionVotes)).toHaveLength(0);
  await callback(`gv:${s.id}:1`);
  await callback(`gv:${s.id}:1`);
  expect(await db.select().from(groupSessionVotes)).toHaveLength(1);
  await callback(`gs:${s.id}`);
  expect((await session()).status).toBe("open");
  await callback(`gp:${s.id}:100`);
  expect(last("sendInvoice").chat_id).toBe(2);
  expect(last("sendInvoice").currency).toBe("XTR");
  await bot.handleUpdate({ update_id: ++sequence, pre_checkout_query: { id: "q", from: person(), currency: "XTR", total_amount: 100, invoice_payload: `s:${s.id}` } });
  expect(last("answerPreCheckoutQuery").ok).toBe(true);
  await payment(s.id, "charge1", 100);
  await payment(s.id, "charge1", 100);
  expect((await db.select().from(products))[0]!.fundedMinor).toBe(130);
  await due();
  await processOutboxBatch(bot.api);
  expect(last("editMessageText").text).toContain("$1.30");
  expect(last("editMessageText").text).toContain("Headphones &lt;3");
  await payment(s.id, "charge2", 700);
  expect((await session()).status).toBe("completed");
  await due();
  await processOutboxBatch(bot.api);
  expect(last("editMessageText").text).toContain("Goal reached!");
  expect(last("editMessageText").reply_markup.inline_keyboard.flat()).toEqual([]);
  await bot.handleUpdate({ update_id: ++sequence, message: { message_id: sequence, date: 1, chat: chat(2), from: person(), refunded_payment: { currency: "XTR", total_amount: 700, invoice_payload: `s:${s.id}`, telegram_payment_charge_id: "charge2", provider_payment_charge_id: "" } } } as Update);
  expect((await db.select().from(products))[0]!.status).toBe("active");
});

test("stale and cross-chat callbacks expire; only starter/admin can close", async () => {
  await command("/fundraise @owner");
  const s = await session();
  for (const data of ["unknown", "gv:------------------------------------:1", `gp:${s.id}:100`, `mc:${crypto.randomUUID()}`, `fa:${crypto.randomUUID()}`]) {
    await callback(data);
    expect(last("answerCallbackQuery").text).toBe("This button has expired.");
  }
  await callback(`gs:${s.id}`, 2, -20);
  expect(last("answerCallbackQuery").text).toBe("This button has expired.");
  await callback(`gx:${s.id}`, 1);
  expect((await session()).status).toBe("voting");
  await command("/cancel");
  expect((await session()).status).toBe("cancelled");
  await callback(`gs:${s.id}`);
  expect(last("answerCallbackQuery").text).toBe("This button has expired.");
});

test("follow and manual callbacks enforce recipient ownership and reject stale buttons", async () => {
  await db.insert(follows).values({ followerId: friend.id, followeeId: owner.id });
  await callback(`fa:${friend.id}`, 1, 1);
  expect((await db.select().from(follows))[0]!.status).toBe("accepted");
  await callback(`fd:${friend.id}`, 1, 1);
  expect(last("answerCallbackQuery").text).toBe("This button has expired.");
  const [c] = await db.insert(contributions).values({ productId: product.id, contributorId: friend.id, method: "manual", status: "awaiting_confirmation", amountMinor: 100, currency: "USD" }).returning();
  await callback(`mc:${c!.id}`, 2, 2);
  expect((await db.select().from(contributions))[0]!.status).toBe("awaiting_confirmation");
  await callback(`mr:${c!.id}`, 1, 1);
  expect((await db.select().from(contributions))[0]!.status).toBe("rejected");
});

test("outbox merges progress bursts and honours 429, 403, and notification preferences", async () => {
  await command("/fundraise @owner 1");
  const s = await session();
  await enqueue(db, { kind: "group_progress", chatId: -10, payload: { sessionId: s.id } });
  await enqueue(db, { kind: "group_progress", chatId: -10, payload: { sessionId: s.id } });
  expect(await db.select().from(notificationOutbox)).toHaveLength(1);
  await due();
  failure = { code: 429, retryAfter: 7 };
  const before = Date.now();
  await processOutboxBatch(bot.api);
  let [row] = await db.select().from(notificationOutbox);
  expect(row!.status).toBe("pending");
  expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 6000);
  failure = undefined;
  await due();
  await processOutboxBatch(bot.api);
  await enqueue(db, { kind: "follow_request", userId: owner.id, payload: { followerId: friend.id } });
  failure = { code: 403 };
  await processOutboxBatch(bot.api);
  expect((await db.select().from(users).where(eq(users.id, owner.id)))[0]!.canDm).toBe(false);
  expect((await db.select().from(notificationOutbox)).some(r => r.status === "failed")).toBe(true);
  failure = undefined;
  const sent = calls.filter(c => c.method === "sendMessage").length;
  await enqueue(db, { kind: "follow_accepted", userId: owner.id, payload: { followeeId: friend.id } });
  await processOutboxBatch(bot.api);
  expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(sent);
});

test("direct selection, status, contribution routing, and close preserve credited money", async () => {
  await command("/fundraise @owner 1");
  const s = await session();
  await command("/status");
  expect((await session()).progressMessageId).not.toBe(s.progressMessageId);
  await db.update(users).set({ canDm: false }).where(eq(users.id, friend.id));
  await command("/contribute 100");
  expect(last("sendInvoice").chat_id).toBe(-10);
  await command("/contribute -1");
  expect(last("sendMessage").text).toContain("Usage:");
  await command("/help");
  expect(last("sendMessage").text).toContain("Group gifts");
  await payment(s.id, "credited", 100);
  await command("/close");
  expect((await session()).status).toBe("closed");
  expect((await db.select().from(products))[0]!.fundedMinor).toBe(130);
});

test("start opens the next public wish when the top vote is no longer eligible", async () => {
  const [more] = await db.insert(wishlists).values({ ownerId: owner.id, title: "More", position: 1 }).returning();
  const [speaker] = await db.insert(products).values({ wishlistId: more!.id, title: "Speaker", priceMinor: 500, currency: "USD" }).returning();
  await command("/fundraise @owner");
  const s = await session();
  expect(s.candidateProductIds).toEqual([product.id, speaker!.id]);
  await callback(`gv:${s.id}:1`);
  await db.update(wishlists).set({ visibility: "private" }).where(eq(wishlists.id, product.wishlistId));
  await callback(`gs:${s.id}`);
  const started = await session();
  expect(started.status).toBe("open");
  expect(started.productId).toBe(speaker!.id);
  expect(last("answerCallbackQuery").text).toBe("Collecting started!");
});

test("webhook rejects a bad secret with 401 and returns 500 when a payment fails", async () => {
  const handle = createWebhookHandler(bot, "test-secret");
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/telegram/webhook") return handle(req);
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const endpoint = `http://127.0.0.1:${server.port}/telegram/webhook`;
    const bad = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
    const failed = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({
        update_id: ++sequence,
        message: {
          message_id: sequence,
          date: 1,
          chat: chat(-10),
          from: person(),
          successful_payment: {
            currency: "XTR",
            total_amount: 50,
            invoice_payload: "not-an-invoice",
            telegram_payment_charge_id: "missing-charge",
            provider_payment_charge_id: "",
          },
        },
      }),
    });
    expect(failed.status).toBe(500);
  } finally {
    server.stop(true);
  }
});

test("private wishes stay out of group voting and a withdrawn public wish cannot start", async () => {
  const [w] = await db.insert(wishlists).values({ ownerId: owner.id, title: "Secret", visibility: "private" }).returning();
  await db.insert(products).values({ wishlistId: w!.id, title: "Secret wish", priceMinor: 100, currency: "USD" });
  await command("/fundraise @owner");
  const s = await session();
  expect(s.candidateProductIds).toEqual([product.id]);
  expect(last("sendMessage").text).not.toContain("Secret wish");
  await db.update(wishlists).set({ visibility: "private" }).where(eq(wishlists.id, product.wishlistId));
  await callback(`gs:${s.id}`);
  expect(last("answerCallbackQuery").text).toBe("This button has expired.");
  expect((await session()).status).toBe("voting");
});

test("all DM notification kinds render with anonymous names and escaped notes", async () => {
  const [c] = await db.insert(contributions).values({ productId: product.id, contributorId: friend.id, method: "manual", status: "awaiting_confirmation", amountMinor: 100, currency: "USD", isAnonymous: true, message: "<note>" }).returning();
  for (const kind of ["contribution_received", "manual_claim", "manual_decided"] as const) {
    await enqueue(db, { kind, userId: owner.id, payload: { contributionId: c!.id } });
  }
  await enqueue(db, { kind: "product_funded", userId: owner.id, payload: { productId: product.id } });
  await enqueue(db, { kind: "follow_request", userId: owner.id, payload: { followerId: friend.id } });
  await enqueue(db, { kind: "follow_accepted", userId: owner.id, payload: { followeeId: friend.id } });
  await processOutboxBatch(bot.api);
  const texts = calls.filter(c => c.method === "sendMessage").map(c => c.payload.text);
  expect(texts).toHaveLength(6);
  expect(texts.some(t => t.includes("Someone chipped in"))).toBe(true);
  expect(texts.some(t => t.includes("&lt;note&gt;"))).toBe(true);
  expect(texts.some(t => t.includes("Someone (anonymous)"))).toBe(true);
  expect(texts.some(t => t.includes("not received"))).toBe(true);
  expect(texts.some(t => t.includes("fully funded"))).toBe(true);
  expect(texts.some(t => t.includes("@friend wants to follow"))).toBe(true);
  expect(texts.some(t => t.includes("accepted your follow request"))).toBe(true);
  await db.update(users).set({ notificationsEnabled: false }).where(eq(users.id, owner.id));
  await enqueue(db, { kind: "product_funded", userId: owner.id, payload: { productId: product.id } });
  await processOutboxBatch(bot.api);
  expect(calls.filter(c => c.method === "sendMessage")).toHaveLength(6);
});

test("inline cards are personal, and membership changes maintain DM eligibility", async () => {
  await bot.handleUpdate({ update_id: ++sequence, inline_query: { id: "inline", from: person(1), query: "", offset: "" } });
  expect(last("answerInlineQuery").is_personal).toBe(true);
  expect(last("answerInlineQuery").results).toHaveLength(2);
  await bot.handleUpdate({ update_id: ++sequence, my_chat_member: { chat: chat(2), from: person(), date: 1, old_chat_member: { status: "member", user: me }, new_chat_member: { status: "kicked", user: me, until_date: 0 } } } as Update);
  expect((await db.select().from(users).where(eq(users.id, friend.id)))[0]!.canDm).toBe(false);
  await command("/start", 2);
  expect((await db.select().from(users).where(eq(users.id, friend.id)))[0]!.canDm).toBe(true);
});

test("premium payment keeps each charge and does not clear a missing username", async () => {
  const payer = { id: 1, is_bot: false as const, first_name: "Owner" };
  const pay = (charge: string, term: "a" | "l") =>
    bot.handleUpdate({
      update_id: ++sequence,
      message: {
        message_id: sequence,
        date: 1,
        chat: chat(1),
        from: payer,
        successful_payment: {
          currency: "XTR",
          total_amount: 100,
          invoice_payload: `m:${owner.id}:${term}:100`,
          telegram_payment_charge_id: charge,
          provider_payment_charge_id: "",
        },
      },
    } as Update);
  await pay("prem-1", "a");
  await pay("prem-1", "a");
  await pay("prem-2", "l");
  expect((await db.select().from(users).where(eq(users.id, owner.id)))[0]!.username).toBe("owner");
  expect((await db.select().from(subscriptionPayments)).map((row) => row.telegramPaymentChargeId).sort()).toEqual(["prem-1", "prem-2"]);
  await bot.handleUpdate({
    update_id: ++sequence,
    message: {
      message_id: sequence,
      date: 1,
      chat: chat(1),
      from: payer,
      refunded_payment: {
        currency: "XTR",
        total_amount: 100,
        invoice_payload: `m:${owner.id}:a:100`,
        telegram_payment_charge_id: "prem-1",
        provider_payment_charge_id: "",
      },
    },
  } as Update);
  const [first] = await db.select().from(subscriptionPayments).where(eq(subscriptionPayments.telegramPaymentChargeId, "prem-1"));
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, owner.id));
  expect(first!.refundedAt).not.toBeNull();
  expect(sub!.expiresAt).toBeNull();
  expect((await db.select().from(users).where(eq(users.id, owner.id)))[0]!.username).toBe("owner");
});
