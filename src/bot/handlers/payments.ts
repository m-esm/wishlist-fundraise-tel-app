import { eq } from "drizzle-orm";
import { Composer } from "grammy";
import { db } from "../../db/client";
import { products, type GroupSession } from "../../db/schema";
import { env } from "../../env";
import { STARS } from "../../lib/money";
import {
  invoicePayload,
  recordStarsPayment,
  recordStarsRefund,
  validatePreCheckout,
} from "../../services/contributions";
import {
  parseSubscriptionPayload,
  recordSubscriptionPayment,
  refundSubscription,
  validateSubscriptionPreCheckout,
} from "../../services/subscriptions";
import type { BotContext } from "../context";

/**
 * Telegram Stars (XTR) payment lifecycle:
 *
 *   sendInvoice / createInvoiceLink
 *     payload "c:<contributionId>", "s:<sessionId>", or "m:<userId>:a|l:<stars>"
 *     -> pre_checkout_query           validate, answer within 10 s
 *     -> message.successful_payment   credit (idempotent on telegram_payment_charge_id)
 *     -> message.refunded_payment     reverse credit
 */
export const payments = new Composer<BotContext>();

payments.on("pre_checkout_query", async (ctx) => {
  const q = ctx.preCheckoutQuery;
  const error = await (parseSubscriptionPayload(q.invoice_payload)
    ? validateSubscriptionPreCheckout(db, q.invoice_payload, q.currency, q.total_amount, q.from.id)
    : validatePreCheckout(db, q.invoice_payload, q.currency, q.total_amount)
  ).catch((e) => {
    console.error("pre_checkout validation failed", e);
    return "Temporary error, please try again.";
  });
  await ctx.answerPreCheckoutQuery(error === null, error ?? undefined);
});

payments.on("message:successful_payment", async (ctx) => {
  const p = ctx.message.successful_payment;
  if (p.currency !== STARS) return;
  // Throwing makes grammY return non-200 so Telegram redelivers; the handler is idempotent.
  if (parseSubscriptionPayload(p.invoice_payload)) {
    await recordSubscriptionPayment(db, {
      payload: p.invoice_payload,
      from: ctx.from,
      totalAmount: p.total_amount,
      telegramPaymentChargeId: p.telegram_payment_charge_id,
    });
    if (ctx.chat.type === "private") await ctx.reply("Thank you! Premium is confirmed.");
    return;
  }
  await recordStarsPayment(db, {
    payload: p.invoice_payload,
    from: ctx.from,
    totalAmount: p.total_amount,
    telegramPaymentChargeId: p.telegram_payment_charge_id,
    providerPaymentChargeId: p.provider_payment_charge_id,
  });
  if (ctx.chat.type === "private") {
    await ctx.reply(`Thank you! ⭐ ${p.total_amount} received. Your contribution is confirmed.`);
  }
  // In groups the live progress message is updated through the outbox.
});

payments.on("message:refunded_payment", async (ctx) => {
  const chargeId = ctx.message.refunded_payment.telegram_payment_charge_id;
  if (await refundSubscription(db, chargeId)) return;
  await recordStarsRefund(db, chargeId);
});

/**
 * Quick-contribute from a group: invoice goes to the user's DM when the bot
 * can write to them (keeps the group clean), otherwise into the group.
 * Anyone in the chat can pay a group invoice; the payer is ctx.from on
 * successful_payment, so the contribution is attributed correctly.
 */
export async function sendSessionInvoice(ctx: BotContext, s: GroupSession, stars: number) {
  const [p] = await db.select().from(products).where(eq(products.id, s.productId!));
  if (!p) return;
  const toDm = ctx.dbUser?.canDm === true;
  await ctx.api.sendInvoice(
    toDm ? ctx.from!.id : ctx.chat!.id,
    `Gift: ${p.title}`.slice(0, 32),
    `Chip in ${stars} ⭐ toward "${p.title}"`.slice(0, 255),
    invoicePayload.forSession(s.id),
    STARS,
    [{ label: "Contribution", amount: stars }],
    { provider_token: "", photo_url: p.imageUrl ?? undefined },
  );
  return toDm;
}

/** /paysupport is mandatory for bots that sell with Stars. */
payments.chatType("private").command("paysupport", async (ctx) => {
  await ctx.reply(
    "Payment problem? Use /paysupport followed by the problem, date, and amount. " +
      "We reply within 48 hours. Refunds for Stars go back to your Telegram balance.",
  );
  if (env.SUPPORT_CHAT_ID && ctx.from) {
    await ctx.api.sendMessage(
      env.SUPPORT_CHAT_ID,
      `/paysupport from ${ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name} (tg id ${ctx.from.id})\n${ctx.match.trim() || "No details supplied."}`,
    );
  }
});
