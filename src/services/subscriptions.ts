import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { subscriptions, users, type User } from "../db/schema";
import { env } from "../env";
import {
  ANNUAL_DAYS,
  PREMIUM_PRICE_CURRENCY,
  PREMIUM_PRICE_MINOR,
  TRIAL_DAYS,
  planOf,
  type Plan,
} from "../lib/entitlements";
import { STARS, minorToStars } from "../lib/money";
import { tg } from "../lib/telegram";
import type { TelegramUserLike } from "./users";

const DAY_MS = 86_400_000;

export class SubscriptionError extends Error {
  constructor(
    readonly trpcCode: "CONFLICT" | "PRECONDITION_FAILED" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
  }
}

export type PremiumTerm = "annual" | "lifetime";

/** Invoice payload (<= 128 bytes): m:<userId>:a|l:<stars locked at checkout>. */
export function subscriptionPayload(userId: string, term: PremiumTerm, stars: number): string {
  return `m:${userId}:${term === "annual" ? "a" : "l"}:${stars}`;
}

export function parseSubscriptionPayload(
  raw: string,
): { userId: string; term: PremiumTerm; stars: number } | null {
  const m = /^m:([0-9a-f-]{36}):([al]):(\d{1,6})$/.exec(raw);
  if (!m) return null;
  const stars = Number(m[3]);
  if (!Number.isInteger(stars) || stars < 1) return null;
  return { userId: m[1]!, term: m[2] === "a" ? "annual" : "lifetime", stars };
}

/** Stars for €12.50 at the current EUR rate, or null when the rate is missing or out of range. */
export function premiumStarsQuote(): number | null {
  if (!env.STARS_RATES[PREMIUM_PRICE_CURRENCY]) return null;
  const stars = minorToStars(PREMIUM_PRICE_MINOR, PREMIUM_PRICE_CURRENCY);
  if (stars < env.STARS_MIN || stars > env.STARS_MAX) return null;
  return stars;
}

export interface SubscriptionStatus {
  plan: Plan;
  expiresAt: Date | null;
  lifetime: boolean;
  trialAvailable: boolean;
  annualStars: number | null;
  lifetimeStars: number | null;
  priceMinor: number;
  priceCurrency: string;
  trialDays: number;
}

export async function subscriptionStatus(db: DB, userId: string): Promise<SubscriptionStatus> {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const plan = await planOf(db, userId);
  const stars = premiumStarsQuote();
  return {
    plan,
    expiresAt: row?.expiresAt ?? null,
    lifetime: plan === "premium" && row?.expiresAt == null,
    trialAvailable: !row,
    annualStars: stars,
    lifetimeStars: stars,
    priceMinor: PREMIUM_PRICE_MINOR,
    priceCurrency: PREMIUM_PRICE_CURRENCY,
    trialDays: TRIAL_DAYS,
  };
}

/** First-ever Premium activation. A subscription row, even an expired one, uses the trial up. */
export async function initiateTrial(db: DB, userId: string): Promise<{ expiresAt: Date }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .for("update");
    if (existing) throw new SubscriptionError("CONFLICT", "A free trial is only available once.");
    const expiresAt = new Date(Date.now() + TRIAL_DAYS * DAY_MS);
    await tx.insert(subscriptions).values({ userId, plan: "premium", expiresAt });
    return { expiresAt };
  });
}

function invoiceCopy(term: PremiumTerm): { title: string; description: string } {
  if (term === "annual") {
    return {
      title: "Premium for 1 year",
      description: "One year of unlimited wishlists and wishes. €12.50 converted to Stars.",
    };
  }
  return {
    title: "Premium for life",
    description: "Unlimited wishlists and wishes with no end date. €12.50 converted to Stars.",
  };
}

/** Issues a Stars invoice. The bot confirms Premium on successful_payment. */
export async function createPremiumInvoice(db: DB, user: User, term: PremiumTerm) {
  const stars = premiumStarsQuote();
  if (stars == null) {
    throw new SubscriptionError("PRECONDITION_FAILED", "Set STARS_RATES for EUR before selling Premium.");
  }
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  if (row?.plan === "premium" && row.expiresAt == null) {
    throw new SubscriptionError("CONFLICT", "Lifetime Premium is already active.");
  }
  const copy = invoiceCopy(term);
  const payload = subscriptionPayload(user.id, term, stars);
  const invoiceLink = await tg.createInvoiceLink(
    copy.title,
    copy.description,
    payload,
    "",
    STARS,
    [{ label: copy.title, amount: stars }],
  );
  return { invoiceLink, stars };
}

/**
 * pre_checkout_query gate for a Premium invoice. Returns an error message, or
 * null to approve. The Stars amount must still match the current EUR quote.
 */
export async function validateSubscriptionPreCheckout(
  db: DB,
  rawPayload: string,
  currency: string,
  totalAmount: number,
  fromTelegramId: number,
): Promise<string | null> {
  const parsed = parseSubscriptionPayload(rawPayload);
  const expected = premiumStarsQuote();
  if (!parsed || currency !== STARS || expected == null || parsed.stars !== expected || totalAmount !== parsed.stars) {
    return parsed && currency === STARS ? "Amount mismatch." : "This invoice is not valid.";
  }
  const [user] = await db.select().from(users).where(eq(users.id, parsed.userId));
  if (!user || user.telegramId !== fromTelegramId) return "This invoice is not valid.";
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
  if (row?.plan === "premium" && row.expiresAt == null) return "Lifetime Premium is already active.";
  return null;
}

export interface SubscriptionPayment {
  payload: string;
  from: TelegramUserLike;
  totalAmount: number;
  telegramPaymentChargeId: string;
}

/**
 * Confirms a Premium Stars payment. Idempotent on telegram_payment_charge_id.
 * Money is already taken, so a redelivery must not throw after the first credit.
 */
export async function recordSubscriptionPayment(db: DB, pay: SubscriptionPayment): Promise<void> {
  const parsed = parseSubscriptionPayload(pay.payload);
  if (!parsed) throw new SubscriptionError("BAD_REQUEST", `unknown invoice payload ${pay.payload}`);
  if (pay.totalAmount !== parsed.stars) throw new SubscriptionError("BAD_REQUEST", "amount mismatch");

  await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.telegramPaymentChargeId, pay.telegramPaymentChargeId));
    if (dup) return;

    const [payer] = await tx.select().from(users).where(eq(users.telegramId, pay.from.id)).for("update");
    if (!payer || payer.id !== parsed.userId) throw new SubscriptionError("BAD_REQUEST", "payer does not match invoice");

    const [existing] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, payer.id))
      .for("update");
    if (existing?.plan === "premium" && existing.expiresAt == null) {
      await tx
        .update(subscriptions)
        .set({ telegramPaymentChargeId: pay.telegramPaymentChargeId })
        .where(eq(subscriptions.userId, payer.id));
      return;
    }

    const now = new Date();
    const expiresAt =
      parsed.term === "lifetime"
        ? null
        : new Date((existing?.expiresAt && existing.expiresAt > now ? existing.expiresAt : now).getTime() + ANNUAL_DAYS * DAY_MS);

    if (existing) {
      await tx
        .update(subscriptions)
        .set({ plan: "premium", expiresAt, telegramPaymentChargeId: pay.telegramPaymentChargeId })
        .where(eq(subscriptions.userId, payer.id));
    } else {
      await tx.insert(subscriptions).values({
        userId: payer.id,
        plan: "premium",
        expiresAt,
        telegramPaymentChargeId: pay.telegramPaymentChargeId,
      });
    }
  });
}

/** Ends Premium when Stars for that charge are refunded. Returns false when the charge is not a subscription. */
export async function refundSubscription(db: DB, telegramPaymentChargeId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.telegramPaymentChargeId, telegramPaymentChargeId))
      .for("update");
    if (!row) return false;
    await tx.update(subscriptions).set({ expiresAt: new Date() }).where(eq(subscriptions.id, row.id));
    return true;
  });
}
