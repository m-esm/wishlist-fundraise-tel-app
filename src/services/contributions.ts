import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "../db/client";
import { contributions, groupSessions, products, wishlists, type Contribution } from "../db/schema";
import { STARS, starsToMinor } from "../lib/money";
import { enqueue } from "./outbox";
import { insertTelegramUserIfAbsent, type TelegramUserLike } from "./users";

/*
 * All money state transitions live here so the API (manual decisions) and
 * the bot (Stars payments) share one implementation.
 *
 * Invariant: products.funded_minor = sum(amount_minor) of its contributions
 * with status = 'confirmed'. Every transition that enters or leaves
 * 'confirmed' adjusts funded_minor in the same transaction, under a row lock
 * on the contribution.
 */

/** Invoice payloads (<= 128 bytes). */
export const invoicePayload = {
  forContribution: (id: string) => `c:${id}`, // Mini App: pre-created pending row
  forSession: (id: string) => `s:${id}`, // Group invoice: row created on payment
  parse(raw: string): { kind: "contribution" | "session"; id: string } | null {
    const m = /^([cs]):([0-9a-f-]{36})$/.exec(raw);
    if (!m) return null;
    return { kind: m[1] === "c" ? "contribution" : "session", id: m[2]! };
  },
};

export class ContributionError extends Error {}

async function ownerOfProduct(tx: Tx, productId: string): Promise<string> {
  const [row] = await tx
    .select({ ownerId: wishlists.ownerId })
    .from(products)
    .innerJoin(wishlists, eq(wishlists.id, products.wishlistId))
    .where(eq(products.id, productId));
  if (!row) throw new ContributionError("product not found");
  return row.ownerId;
}

/** Moves a locked contribution into 'confirmed' and credits the product. */
async function credit(tx: Tx, c: Contribution, decidedById: string | null): Promise<void> {
  await tx
    .update(contributions)
    .set({ status: "confirmed", confirmedAt: new Date(), decidedById, decidedAt: decidedById ? new Date() : null })
    .where(eq(contributions.id, c.id));

  const [before] = await tx
    .select({ funded: products.fundedMinor, price: products.priceMinor, status: products.status })
    .from(products)
    .where(eq(products.id, c.productId))
    .for("update");
  if (!before) throw new ContributionError("product not found");

  const funded = before.funded + c.amountMinor;
  const crossed = before.status === "active" && funded >= before.price;
  await tx
    .update(products)
    .set({ fundedMinor: funded, ...(crossed ? { status: "funded", fundedAt: new Date() } : {}) })
    .where(eq(products.id, c.productId));

  const ownerId = await ownerOfProduct(tx, c.productId);
  if (c.method === "stars") {
    await enqueue(tx, { kind: "contribution_received", userId: ownerId, payload: { contributionId: c.id } });
  } else {
    await enqueue(tx, { kind: "manual_decided", userId: c.contributorId, payload: { contributionId: c.id } });
  }
  if (crossed) {
    await enqueue(tx, { kind: "product_funded", userId: ownerId, payload: { productId: c.productId } });
    await tx
      .update(groupSessions)
      .set({ status: "completed", closedAt: new Date() })
      .where(and(eq(groupSessions.productId, c.productId), eq(groupSessions.status, "open")));
  }
  await enqueueSessionProgress(tx, c.productId);
}

/** Refresh the live progress message of every group session tracking this product. */
async function enqueueSessionProgress(tx: Tx, productId: string) {
  const sessions = await tx
    .select({ id: groupSessions.id, chatId: groupSessions.telegramChatId })
    .from(groupSessions)
    .where(and(eq(groupSessions.productId, productId), inArray(groupSessions.status, ["open", "completed"])));
  for (const s of sessions) {
    await enqueue(tx, { kind: "group_progress", chatId: s.chatId, payload: { sessionId: s.id } });
  }
}

// ---------------------------------------------------------------- Stars

/**
 * pre_checkout_query gate. Must answer within 10 s. Returns an error message
 * for the user, or null to approve.
 */
export async function validatePreCheckout(
  db: DB,
  rawPayload: string,
  currency: string,
  totalAmount: number,
): Promise<string | null> {
  const p = invoicePayload.parse(rawPayload);
  if (!p || currency !== STARS) return "This invoice is not valid.";

  if (p.kind === "contribution") {
    const [row] = await db
      .select({ c: contributions, productStatus: products.status })
      .from(contributions)
      .innerJoin(products, eq(products.id, contributions.productId))
      .where(eq(contributions.id, p.id));
    if (!row || row.c.method !== "stars") return "This invoice is not valid.";
    if (row.c.status !== "pending") return "This invoice was already used or cancelled.";
    if (row.c.starsAmount !== totalAmount) return "Amount mismatch.";
    if (row.productStatus !== "active") return "This wish is no longer collecting.";
    return null;
  }

  const [s] = await db
    .select({ status: groupSessions.status, productStatus: products.status })
    .from(groupSessions)
    .innerJoin(products, eq(products.id, groupSessions.productId))
    .where(eq(groupSessions.id, p.id));
  if (!s || s.status !== "open" || s.productStatus !== "active") return "This fundraiser is closed.";
  return null;
}

export interface SuccessfulStarsPayment {
  payload: string;
  from: TelegramUserLike;
  totalAmount: number;
  telegramPaymentChargeId: string;
  providerPaymentChargeId: string;
}

/**
 * Handles message.successful_payment. Idempotent on telegram_payment_charge_id
 * (Telegram may redeliver the update). Money has been taken at this point, so
 * we always credit — even if the product closed between pre-checkout and now.
 */
export async function recordStarsPayment(db: DB, pay: SuccessfulStarsPayment): Promise<Contribution> {
  return db.transaction(async (tx) => {
    const [dup] = await tx
      .select()
      .from(contributions)
      .where(eq(contributions.telegramPaymentChargeId, pay.telegramPaymentChargeId));
    if (dup) return dup;

    const p = invoicePayload.parse(pay.payload);
    if (!p) throw new ContributionError(`unknown invoice payload ${pay.payload}`);
    const charge = {
      telegramPaymentChargeId: pay.telegramPaymentChargeId,
      providerPaymentChargeId: pay.providerPaymentChargeId,
    };

    let c: Contribution | undefined;
    if (p.kind === "contribution") {
      [c] = await tx.select().from(contributions).where(eq(contributions.id, p.id)).for("update");
      if (!c) throw new ContributionError("contribution not found");
      if (c.status === "confirmed") return c;
      [c] = await tx.update(contributions).set(charge).where(eq(contributions.id, c.id)).returning();
    } else {
      const contributor = await insertTelegramUserIfAbsent(tx, pay.from);
      const [s] = await tx
        .select({ productId: groupSessions.productId, currency: products.currency })
        .from(groupSessions)
        .innerJoin(products, eq(products.id, groupSessions.productId))
        .where(eq(groupSessions.id, p.id));
      if (!s?.productId) throw new ContributionError("session has no product");
      const { amountMinor, rate } = starsToMinor(pay.totalAmount, s.currency);
      [c] = await tx
        .insert(contributions)
        .values({
          productId: s.productId,
          contributorId: contributor.id,
          groupSessionId: p.id,
          method: "stars",
          status: "pending",
          amountMinor: Math.max(1, amountMinor),
          currency: s.currency,
          starsAmount: pay.totalAmount,
          starsRate: rate,
          ...charge,
        })
        .returning();
    }
    await credit(tx, c!, null);
    return { ...c!, status: "confirmed" };
  });
}

/** Handles message.refunded_payment (or an admin-initiated refundStarPayment). */
export async function recordStarsRefund(db: DB, telegramPaymentChargeId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(contributions)
      .where(eq(contributions.telegramPaymentChargeId, telegramPaymentChargeId))
      .for("update");
    if (!c || c.status !== "confirmed") return;
    await tx.update(contributions).set({ status: "refunded" }).where(eq(contributions.id, c.id));
    await tx
      .update(products)
      .set({
        fundedMinor: sql`greatest(0, ${products.fundedMinor} - ${c.amountMinor})`,
        status: sql`case when ${products.status} = 'funded' and ${products.fundedMinor} - ${c.amountMinor} < ${products.priceMinor} then 'active'::product_status else ${products.status} end`,
      })
      .where(eq(products.id, c.productId));
    await enqueueSessionProgress(tx, c.productId);
  });
}

// ---------------------------------------------------------------- manual ("fake") payments

/** Owner accepts or rejects a declared manual payment. */
export async function decideManual(
  db: DB,
  contributionId: string,
  actorId: string,
  decision: "confirm" | "reject",
): Promise<Contribution> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(contributions).where(eq(contributions.id, contributionId)).for("update");
    if (!c || c.method !== "manual") throw new ContributionError("contribution not found");
    if ((await ownerOfProduct(tx, c.productId)) !== actorId) throw new ContributionError("forbidden");
    if (c.status !== "awaiting_confirmation") throw new ContributionError(`already ${c.status}`);

    if (decision === "confirm") {
      await credit(tx, c, actorId);
      return { ...c, status: "confirmed" as const };
    }
    const [r] = await tx
      .update(contributions)
      .set({ status: "rejected", decidedById: actorId, decidedAt: new Date() })
      .where(eq(contributions.id, c.id))
      .returning();
    await enqueue(tx, { kind: "manual_decided", userId: c.contributorId, payload: { contributionId: c.id } });
    return r!;
  });
}
