import "../../test/net";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { subscriptionPayments, subscriptions, users } from "../../db/schema";
import { planOf } from "../../lib/entitlements";
import { minorToStars } from "../../lib/money";
import {
  parseSubscriptionPayload,
  recordSubscriptionPayment,
  refundSubscription,
  validateSubscriptionPreCheckout,
} from "../../services/subscriptions";
import { fixture, newWishlist } from "../../test/fixtures";
import { fakeTelegram, resetFakesBeforeEach } from "../../test/net";

resetFakesBeforeEach();

const STARS = minorToStars(1250, "EUR");

describe("subscriptions router", () => {
  test("a free user can start one 30-day trial and then pass the wishlist limit", async () => {
    const f = await fixture();
    const before = await f.ownerCaller.subscriptions.getStatus();
    expect(before.plan).toBe("free");
    expect(before.trialAvailable).toBe(true);
    expect(before.annualStars).toBe(STARS);
    expect(before.lifetimeStars).toBe(STARS);
    expect(before.priceMinor).toBe(1250);
    expect(before.priceCurrency).toBe("EUR");

    const trial = await f.ownerCaller.subscriptions.initiateTrial();
    const delta = trial.expiresAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan(29 * 86_400_000);
    expect(delta).toBeLessThan(31 * 86_400_000);
    expect(await planOf(f.db, f.owner.id)).toBe("premium");
    await newWishlist(f.db, f.owner.id, "public", "Second");
    await f.ownerCaller.wishlists.create({ title: "Third" });

    await expect(f.ownerCaller.subscriptions.initiateTrial()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A free trial is only available once.",
    });
    expect((await f.ownerCaller.subscriptions.getStatus()).trialAvailable).toBe(false);
  });

  test("annual and lifetime invoices lock the current Stars quote", async () => {
    const f = await fixture();
    const annual = await f.ownerCaller.subscriptions.purchaseAnnual();
    const lifetime = await f.friendCaller.subscriptions.purchaseLifetime();
    expect(annual.stars).toBe(STARS);
    expect(lifetime.stars).toBe(STARS);
    expect(annual.invoiceLink).toBe(`https://t.me/invoice/m:${f.owner.id}:a:${STARS}`);
    const premiumLinks = fakeTelegram.invoiceLinks.filter((link) => link.payload.startsWith("m:"));
    expect(premiumLinks.map((link) => link.prices)).toEqual([
      [{ label: "Premium for 1 year", amount: STARS }],
      [{ label: "Premium for life", amount: STARS }],
    ]);
    expect(premiumLinks.every((link) => link.currency === "XTR")).toBe(true);
  });

  test("payment confirms annual, extends a trial, then lifetime clears the end date", async () => {
    const f = await fixture();
    await f.ownerCaller.subscriptions.initiateTrial();
    const [trial] = await f.db.select().from(subscriptions).where(eq(subscriptions.userId, f.owner.id));
    const annual = await f.ownerCaller.subscriptions.purchaseAnnual();
    const payload = annual.invoiceLink.replace("https://t.me/invoice/", "");
    expect(parseSubscriptionPayload(payload)?.term).toBe("annual");

    const from = { id: f.owner.telegramId, first_name: f.owner.firstName };
    expect(await validateSubscriptionPreCheckout(f.db, payload, "XTR", STARS, from.id)).toBeNull();
    expect(await validateSubscriptionPreCheckout(f.db, payload, "XTR", 1, from.id)).toBe("Amount mismatch.");
    expect(await validateSubscriptionPreCheckout(f.db, payload, "XTR", STARS, f.friend.telegramId)).toBe(
      "This invoice is not valid.",
    );

    await recordSubscriptionPayment(f.db, {
      payload,
      from,
      totalAmount: STARS,
      telegramPaymentChargeId: "annual-1",
    });
    await recordSubscriptionPayment(f.db, {
      payload,
      from,
      totalAmount: STARS,
      telegramPaymentChargeId: "annual-1",
    });
    const [paid] = await f.db.select().from(subscriptions).where(eq(subscriptions.userId, f.owner.id));
    expect(paid!.expiresAt!.getTime() - trial!.expiresAt!.getTime()).toBe(365 * 86_400_000);

    const life = await f.ownerCaller.subscriptions.purchaseLifetime();
    await recordSubscriptionPayment(f.db, {
      payload: life.invoiceLink.replace("https://t.me/invoice/", ""),
      from,
      totalAmount: STARS,
      telegramPaymentChargeId: "life-1",
    });
    const status = await f.ownerCaller.subscriptions.getStatus();
    expect(status.lifetime).toBe(true);
    expect(status.expiresAt).toBeNull();
    await expect(f.ownerCaller.subscriptions.purchaseAnnual()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Lifetime Premium is already active.",
    });

    expect(await refundSubscription(f.db, "life-1")).toBe(true);
    const afterLifeRefund = await f.ownerCaller.subscriptions.getStatus();
    expect(afterLifeRefund.lifetime).toBe(false);
    expect(afterLifeRefund.plan).toBe("premium");
    expect(await refundSubscription(f.db, "annual-1")).toBe(true);
    const [restored] = await f.db.select().from(subscriptions).where(eq(subscriptions.userId, f.owner.id));
    expect(restored!.expiresAt!.getTime()).toBe(trial!.expiresAt!.getTime());
    expect(await planOf(f.db, f.owner.id)).toBe("premium");
    expect(await refundSubscription(f.db, "missing")).toBe(false);
  });

  test("a second charge keeps its own row, redelivery does not duplicate it, and a refund of the first charge still resolves", async () => {
    const f = await fixture();
    const annual = await f.ownerCaller.subscriptions.purchaseAnnual();
    const payload = annual.invoiceLink.replace("https://t.me/invoice/", "");
    const from = { id: f.owner.telegramId, first_name: f.owner.firstName };
    await recordSubscriptionPayment(f.db, {
      payload,
      from,
      totalAmount: STARS,
      telegramPaymentChargeId: "annual-1",
    });
    const [firstTerm] = await f.db.select().from(subscriptions).where(eq(subscriptions.userId, f.owner.id));
    await recordSubscriptionPayment(f.db, {
      payload,
      from,
      totalAmount: STARS,
      telegramPaymentChargeId: "annual-1",
    });
    expect(await f.db.select().from(subscriptionPayments)).toHaveLength(1);
    const [afterRedelivery] = await f.db.select().from(subscriptions).where(eq(subscriptions.userId, f.owner.id));
    expect(afterRedelivery!.expiresAt!.getTime()).toBe(firstTerm!.expiresAt!.getTime());

    await recordSubscriptionPayment(f.db, {
      payload,
      from,
      totalAmount: STARS,
      telegramPaymentChargeId: "annual-2",
    });
    const charges = await f.db.select().from(subscriptionPayments);
    expect(charges.map((row) => row.telegramPaymentChargeId).sort()).toEqual(["annual-1", "annual-2"]);
    const [extended] = await f.db.select().from(subscriptions).where(eq(subscriptions.userId, f.owner.id));
    expect(extended!.expiresAt!.getTime() - firstTerm!.expiresAt!.getTime()).toBe(365 * 86_400_000);

    expect(await refundSubscription(f.db, "annual-1")).toBe(true);
    const [refundedFirst] = await f.db
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.telegramPaymentChargeId, "annual-1"));
    const [keptSecond] = await f.db
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.telegramPaymentChargeId, "annual-2"));
    expect(refundedFirst!.refundedAt).not.toBeNull();
    expect(keptSecond!.refundedAt).toBeNull();
    const [afterRefund] = await f.db.select().from(subscriptions).where(eq(subscriptions.userId, f.owner.id));
    expect(afterRefund!.expiresAt!.getTime() - keptSecond!.createdAt.getTime()).toBe(365 * 86_400_000);
    expect(await planOf(f.db, f.owner.id)).toBe("premium");
    expect(await refundSubscription(f.db, "annual-1")).toBe(true);
    expect((await f.db.select().from(subscriptions).where(eq(subscriptions.userId, f.owner.id)))[0]!.expiresAt!.getTime()).toBe(
      afterRefund!.expiresAt!.getTime(),
    );
  });

  test("recording a payment does not write username null", async () => {
    const f = await fixture();
    const annual = await f.ownerCaller.subscriptions.purchaseAnnual();
    await recordSubscriptionPayment(f.db, {
      payload: annual.invoiceLink.replace("https://t.me/invoice/", ""),
      from: { id: f.owner.telegramId, first_name: f.owner.firstName },
      totalAmount: STARS,
      telegramPaymentChargeId: "annual-name",
    });
    const [user] = await f.db.select().from(users).where(eq(users.id, f.owner.id));
    expect(user!.username).toBe("owner");
  });
});
