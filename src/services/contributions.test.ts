import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { contributions, groupSessions, notificationOutbox, products, telegramChats, users, wishlists } from "../db/schema";
import { assertCanAddProduct, assertCanHaveWishlist } from "../lib/entitlements";
import { testDb } from "../test/pglite";
import {
  ContributionError,
  decideManual,
  invoicePayload,
  recordStarsPayment,
  recordStarsRefund,
  validatePreCheckout,
} from "./contributions";

let db: DB;
let owner: typeof users.$inferSelect;
let friend: typeof users.$inferSelect;
let product: typeof products.$inferSelect;

beforeEach(async () => {
  db = await testDb();
  [owner] = await db.insert(users).values({ telegramId: 1, firstName: "Owner", username: "owner" }).returning() as [typeof owner];
  [friend] = await db.insert(users).values({ telegramId: 2, firstName: "Friend", username: "friend" }).returning() as [typeof friend];
  const [w] = await db.insert(wishlists).values({ ownerId: owner.id, title: "Birthday" }).returning();
  [product] = await db.insert(products)
    .values({ wishlistId: w!.id, title: "Headphones", priceMinor: 1000, currency: "USD" }).returning() as [typeof product];
});

const pendingStars = async (stars: number, extra: Partial<typeof contributions.$inferInsert> = {}) => {
  const [c] = await db.insert(contributions).values({
    productId: product.id, contributorId: friend.id, method: "stars", status: "pending",
    amountMinor: Math.floor(stars * 1.3), currency: "USD", starsAmount: stars, starsRate: 1.3, ...extra,
  }).returning();
  return c!;
};
const pay = (payload: string, stars: number, charge: string) =>
  recordStarsPayment(db, {
    payload, totalAmount: stars, telegramPaymentChargeId: charge, providerPaymentChargeId: "",
    from: { id: 2, first_name: "Friend", username: "friend" },
  });
const productNow = async () => (await db.select().from(products).where(eq(products.id, product.id)))[0]!;
const outboxKinds = async () => (await db.select().from(notificationOutbox)).map((r) => r.kind).sort();

describe("Stars payments", () => {
  test("pre-checkout accepts a matching pending invoice and rejects a wrong amount", async () => {
    const c = await pendingStars(500);
    expect(await validatePreCheckout(db, invoicePayload.forContribution(c.id), "XTR", 500)).toBeNull();
    expect(await validatePreCheckout(db, invoicePayload.forContribution(c.id), "XTR", 499)).toBe("Amount mismatch.");
    expect(await validatePreCheckout(db, "garbage", "XTR", 500)).not.toBeNull();
  });

  test("credits once, is idempotent on redelivery, flips to funded, and refunds", async () => {
    const c1 = await pendingStars(500); // 650 cents
    await pay(invoicePayload.forContribution(c1.id), 500, "ch_1");
    await pay(invoicePayload.forContribution(c1.id), 500, "ch_1"); // Telegram redelivery
    expect((await productNow()).fundedMinor).toBe(650);
    expect((await productNow()).status).toBe("active");

    const c2 = await pendingStars(300); // 390 cents -> 1040 >= 1000
    await pay(invoicePayload.forContribution(c2.id), 300, "ch_2");
    expect((await productNow()).fundedMinor).toBe(1040);
    expect((await productNow()).status).toBe("funded");
    expect(await outboxKinds()).toEqual(["contribution_received", "contribution_received", "product_funded"]);

    await recordStarsRefund(db, "ch_1");
    await recordStarsRefund(db, "ch_1"); // idempotent
    expect((await productNow()).fundedMinor).toBe(390);
    expect((await productNow()).status).toBe("active");
  });

  test("group invoice payload creates the contribution on payment and queues a progress edit", async () => {
    await db.insert(telegramChats).values({ chatId: -100123, type: "supergroup", botStatus: "member" });
    const [s] = await db.insert(groupSessions).values({
      telegramChatId: -100123, beneficiaryId: owner.id, createdById: friend.id, status: "open", productId: product.id,
    }).returning();
    expect(await validatePreCheckout(db, invoicePayload.forSession(s!.id), "XTR", 100)).toBeNull();
    const c = await pay(invoicePayload.forSession(s!.id), 100, "ch_g1");
    expect(c.groupSessionId).toBe(s!.id);
    expect(c.amountMinor).toBe(130);
    expect(await outboxKinds()).toContain("group_progress");
  });

  test("a group payment lookup does not write username null", async () => {
    await db.insert(telegramChats).values({ chatId: -100123, type: "supergroup", botStatus: "member" });
    const [s] = await db.insert(groupSessions).values({
      telegramChatId: -100123, beneficiaryId: owner.id, createdById: friend.id, status: "open", productId: product.id,
    }).returning();
    await recordStarsPayment(db, {
      payload: invoicePayload.forSession(s!.id),
      totalAmount: 100,
      telegramPaymentChargeId: "ch_noname",
      providerPaymentChargeId: "",
      from: { id: friend.telegramId, first_name: "Friend" },
    });
    const [row] = await db.select().from(users).where(eq(users.id, friend.id));
    expect(row!.username).toBe("friend");
  });

  test("only one active session per chat", async () => {
    await db.insert(telegramChats).values({ chatId: -1, type: "group", botStatus: "member" });
    const row = { telegramChatId: -1, beneficiaryId: owner.id, createdById: friend.id };
    await db.insert(groupSessions).values(row);
    await expect((async () => db.insert(groupSessions).values(row))()).rejects.toThrow();
  });
});

describe("manual payments", () => {
  test("only the owner can decide, and only once", async () => {
    const [c] = await db.insert(contributions).values({
      productId: product.id, contributorId: friend.id, method: "manual", status: "awaiting_confirmation",
      amountMinor: 400, currency: "USD", isAnonymous: true,
    }).returning();
    await expect(decideManual(db, c!.id, friend.id, "confirm")).rejects.toThrow(ContributionError);
    await decideManual(db, c!.id, owner.id, "confirm");
    expect((await productNow()).fundedMinor).toBe(400);
    await expect(decideManual(db, c!.id, owner.id, "reject")).rejects.toThrow("already confirmed");
    // Anonymous: record keeps the contributor for audit.
    const [stored] = await db.select().from(contributions).where(eq(contributions.id, c!.id));
    expect(stored!.contributorId).toBe(friend.id);
  });
});

describe("free plan limits", () => {
  test("1 public + 1 private list, 5 products per list", async () => {
    // beforeEach created one public list already
    await expect(assertCanHaveWishlist(db, owner.id, "public")).rejects.toThrow("plan_limit:public_wishlists");
    await assertCanHaveWishlist(db, owner.id, "private");
    for (let i = 0; i < 4; i++) {
      await db.insert(products).values({ wishlistId: product.wishlistId, title: `p${i}`, priceMinor: 1, currency: "USD" });
    }
    await expect(assertCanAddProduct(db, owner.id, product.wishlistId)).rejects.toThrow("plan_limit:products_per_wishlist");
  });
});
