import "../../test/net";
import { describe, expect, it, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { contributions, groupSessions, notificationOutbox, products, telegramChats, wishlists } from "../../db/schema";
import { contribution, fixture, newProduct, newWishlist, user } from "../../test/fixtures";
import { fakeTelegram, makeCaller, resetFakesBeforeEach } from "../../test/net";
import { testDb } from "../../test/pglite";

resetFakesBeforeEach();

const byId = async (db: Awaited<ReturnType<typeof fixture>>["db"], id: string) =>
  (await db.select().from(contributions).where(eq(contributions.id, id)))[0]!;

describe("contributions router", () => {
  test("quote converts Stars and reports the Stars needed to finish", async () => {
    const f = await fixture();
    const res = await f.friendCaller.contributions.quote({ productId: f.product.id, stars: 100 });
    expect(res.amountMinor).toBe(130); // STARS_RATES USD:1.3
    expect(res.formatted).toBe("$1.30");
    expect(res.starsToComplete).toBe(770); // 1000 / 1.3 = 769.2 -> 770
  });

  test("quote on a private list I cannot see is NOT_FOUND", async () => {
    const f = await fixture();
    await f.db.update(wishlists).set({ visibility: "private" }).where(eq(wishlists.id, f.wishlist.id));
    await expect(
      f.strangerCaller.contributions.quote({ productId: f.product.id, stars: 100 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("createStarsInvoice stores a pending row and returns a (fake) invoice link", async () => {
    const f = await fixture();
    const res = await f.friendCaller.contributions.createStarsInvoice({
      productId: f.product.id,
      stars: 100,
      message: "Happy birthday!",
      isAnonymous: true,
    });
    expect(res.invoiceLink).toBe(`https://t.me/invoice/c:${res.contributionId}`);
    const row = await byId(f.db, res.contributionId);
    expect(row.method).toBe("stars");
    expect(row.status).toBe("pending");
    expect(row.contributorId).toBe(f.friend.id);
    expect(row.amountMinor).toBe(130);
    expect(row.starsAmount).toBe(100);
    expect(row.starsRate).toBe(1.3);
    expect(row.currency).toBe("USD");
    expect(row.isAnonymous).toBe(true);
    expect(row.message).toBe("Happy birthday!");
    // The link payload the bot later confirms is the contribution id.
    expect(fakeTelegram.invoiceLinks).toHaveLength(1);
    expect(fakeTelegram.invoiceLinks[0]!.currency).toBe("XTR");
    expect(fakeTelegram.invoiceLinks[0]!.prices).toEqual([{ label: "Contribution", amount: 100 }]);
    expect(fakeTelegram.invoiceLinks[0]!.payload).toBe(`c:${res.contributionId}`);
    // Creating an invoice never credits the product.
    expect((await f.db.select().from(products).where(eq(products.id, f.product.id)))[0]!.fundedMinor).toBe(0);
  });

  test("createStarsInvoice rejects the owner, a closed product, and a bad Stars amount", async () => {
    const f = await fixture();
    // Router modules (and the captured fake links) live for the whole process.
    fakeTelegram.invoiceLinks.length = 0;
    await expect(
      f.ownerCaller.contributions.createStarsInvoice({ productId: f.product.id, stars: 100 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await f.db.update(products).set({ status: "archived" }).where(eq(products.id, f.product.id));
    await expect(
      f.friendCaller.contributions.createStarsInvoice({ productId: f.product.id, stars: 100 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.friendCaller.contributions.createStarsInvoice({ productId: f.product.id, stars: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fakeTelegram.invoiceLinks).toHaveLength(0);
  });

  test("createStarsInvoice with a group session: open session only, and the public-list gate", async () => {
    const f = await fixture();
    await f.db.insert(telegramChats).values({ chatId: -2001, type: "supergroup", botStatus: "member" });
    const [session] = await f.db.insert(groupSessions).values({
      telegramChatId: -2001,
      beneficiaryId: f.owner.id,
      createdById: f.friend.id,
      status: "open",
      productId: f.product.id,
    }).returning();
    const stranger = await user(f.db);
    // A group-session link lets a member contribute to a public product.
    const c = await f.strangerCaller.contributions.createStarsInvoice({
      productId: f.product.id,
      stars: 50,
      groupSessionId: session!.id,
    });
    expect((await byId(f.db, c.contributionId)).groupSessionId).toBe(session!.id);
    // But not to a private one.
    const priv = await newWishlist(f.db, (await user(f.db)).id, "private");
    const hidden = await newProduct(f.db, priv.id, "Hidden");
    await expect(
      f.strangerCaller.contributions.createStarsInvoice({ productId: hidden.id, stars: 50, groupSessionId: session!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A closed session does not open a back door.
    await f.db.update(groupSessions).set({ status: "closed" }).where(eq(groupSessions.id, session!.id));
    await expect(
      f.strangerCaller.contributions.createStarsInvoice({ productId: f.product.id, stars: 50, groupSessionId: session!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(stranger.id).toBeTruthy();
  });

  test("createStarsInvoice fails cleanly when Telegram rejects the invoice link", async () => {
    const f = await fixture();
    fakeTelegram.failInvoiceLink = new Error("Bad Request: currency invalid");
    await expect(
      f.friendCaller.contributions.createStarsInvoice({ productId: f.product.id, stars: 100 }),
    ).rejects.toThrow("currency invalid");
    fakeTelegram.failInvoiceLink = undefined;
    // The pending row stays so a retry can reuse it; no funded money moved.
    expect((await f.db.select().from(contributions)).every((c) => c.status === "pending")).toBe(true);
    expect((await f.db.select().from(products).where(eq(products.id, f.product.id)))[0]!.fundedMinor).toBe(0);
  });

  test("declareManual creates awaiting_confirmation and DMs the owner; max 3 open claims", async () => {
    const f = await fixture();
    const claim = await f.friendCaller.contributions.declareManual({
      productId: f.product.id,
      amountMinor: 400,
      message: "Cash",
      isAnonymous: true,
    });
    expect(claim.status).toBe("awaiting_confirmation");
    expect(claim.method).toBe("manual");
    expect(claim.amountMinor).toBe(400);
    expect(claim.currency).toBe("USD");
    const outbox = await f.db.select().from(notificationOutbox);
    expect(outbox.map((o) => [o.kind, o.userId])).toEqual([["manual_claim", f.owner.id]]);
    expect(outbox[0]!.payload).toEqual({ contributionId: claim.id });
    await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 100 });
    await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 100 });
    await expect(
      f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 100 }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect((await f.db.select().from(contributions)).length).toBe(3);
    // A different user has their own allowance.
    await f.strangerCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 100 });
  });

  test("decide: the owner confirms, crediting the product exactly once", async () => {
    const f = await fixture();
    const claim = await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 400 });
    const confirmed = await f.ownerCaller.contributions.decide({ contributionId: claim.id, decision: "confirm" });
    expect(confirmed.status).toBe("confirmed");
    const [p] = await f.db.select().from(products).where(eq(products.id, f.product.id));
    expect(p!.fundedMinor).toBe(400);
    expect((await byId(f.db, claim.id)).decidedById).toBe(f.owner.id);
    await expect(
      f.ownerCaller.contributions.decide({ contributionId: claim.id, decision: "confirm" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await f.db.select().from(products).where(eq(products.id, f.product.id)))[0]!.fundedMinor).toBe(400);
  });

  test("decide: only the owner (FORBIDDEN), and the contributor cannot decide their own claim", async () => {
    const f = await fixture();
    const claim = await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 400 });
    await expect(
      f.friendCaller.contributions.decide({ contributionId: claim.id, decision: "confirm" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.strangerCaller.contributions.decide({ contributionId: claim.id, decision: "reject" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await byId(f.db, claim.id)).status).toBe("awaiting_confirmation");
  });

  test("decide: an unknown contribution or a Stars row is NOT_FOUND", async () => {
    const f = await fixture();
    await expect(
      f.ownerCaller.contributions.decide({
        contributionId: "00000000-0000-4000-8000-000000000000",
        decision: "confirm",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const stars = await contribution(f.db, {
      productId: f.product.id, contributorId: f.friend.id, method: "stars", status: "pending",
    });
    await expect(
      f.ownerCaller.contributions.decide({ contributionId: stars.id, decision: "confirm" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("decide reject: no money moves and the contributor is notified", async () => {
    const f = await fixture();
    const claim = await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 400 });
    const res = await f.ownerCaller.contributions.decide({ contributionId: claim.id, decision: "reject" });
    expect(res.status).toBe("rejected");
    expect((await f.db.select().from(products).where(eq(products.id, f.product.id)))[0]!.fundedMinor).toBe(0);
    const kinds = (await f.db.select().from(notificationOutbox)).map((o) => o.kind);
    expect(kinds).toContain("manual_decided");
  });

  test("cancel withdraws my pending invoice and my undecided claim", async () => {
    const f = await fixture();
    const invoice = await f.friendCaller.contributions.createStarsInvoice({ productId: f.product.id, stars: 100 });
    expect((await f.friendCaller.contributions.cancel({ contributionId: invoice.contributionId })).status).toBe(
      "cancelled",
    );
    const claim = await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 100 });
    expect((await f.friendCaller.contributions.cancel({ contributionId: claim.id })).status).toBe("cancelled");
  });

  test("cancel: not mine is NOT_FOUND, settled is CONFLICT", async () => {
    const f = await fixture();
    const claim = await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 100 });
    await expect(
      f.strangerCaller.contributions.cancel({ contributionId: claim.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.ownerCaller.contributions.decide({ contributionId: claim.id, decision: "confirm" });
    await expect(
      f.friendCaller.contributions.cancel({ contributionId: claim.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("listForProduct shows confirmed rows, the owner also pending claims, and masks anonymous contributors", async () => {
    const f = await fixture();
    const open = await contribution(f.db, {
      productId: f.product.id, contributorId: f.stranger.id, isAnonymous: true, message: "anon gift",
      createdAt: new Date(Date.now() - 3000),
    });
    await contribution(f.db, {
      productId: f.product.id, contributorId: f.friend.id, createdAt: new Date(Date.now() - 2000),
    });
    const pending = await contribution(f.db, {
      productId: f.product.id, contributorId: f.stranger.id, status: "awaiting_confirmation",
      isAnonymous: true, createdAt: new Date(Date.now() - 1000),
    });
    await contribution(f.db, { productId: f.product.id, contributorId: f.stranger.id, status: "rejected" });

    const asReader = await f.friendCaller.contributions.listForProduct({ productId: f.product.id, limit: 30 });
    expect(asReader.items.map((c) => c.status)).toEqual(["confirmed", "confirmed"]);
    const anon = asReader.items.find((c) => c.id === open.id)!;
    expect(anon.contributor).toBeNull();
    expect(anon.isAnonymous).toBe(true);
    expect(anon.message).toBe("anon gift"); // the note stays, identity does not
    expect(asReader.nextCursor).toBeNull();

    // The owner sees the awaiting row but the anonymous contributor is masked for them too.
    const asOwner = await f.ownerCaller.contributions.listForProduct({ productId: f.product.id, limit: 30 });
    expect(asOwner.items.map((c) => c.status)).toEqual(["awaiting_confirmation", "confirmed", "confirmed"]);
    expect(asOwner.items.find((c) => c.id === pending.id)!.contributor).toBeNull();

    // The anonymous contributor still sees themselves.
    const asSelf = await f.strangerCaller.contributions.listForProduct({ productId: f.product.id, limit: 30 });
    expect(asSelf.items.find((c) => c.id === open.id)!.contributor?.id).toBe(f.stranger.id);

    // A non-follower cannot read a private list.
    await f.db.update(wishlists).set({ visibility: "private" }).where(eq(wishlists.id, f.wishlist.id));
    await expect(
      f.strangerCaller.contributions.listForProduct({ productId: f.product.id, limit: 30 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("listForProduct paginates with the opaque cursor and rejects a bad one", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) {
      await contribution(f.db, {
        productId: f.product.id,
        contributorId: f.friend.id,
        createdAt: new Date(Date.now() - (10 - i) * 1000),
      });
    }
    const first = await f.friendCaller.contributions.listForProduct({ productId: f.product.id, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await f.friendCaller.contributions.listForProduct({
      productId: f.product.id,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((c) => c.id));
    expect(ids.size).toBe(3);
    await expect(
      f.friendCaller.contributions.listForProduct({ productId: f.product.id, limit: 2, cursor: "not-a-date" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("mine lists my contributions with the product title", async () => {
    const f = await fixture();
    await contribution(f.db, { productId: f.product.id, contributorId: f.friend.id });
    await contribution(f.db, { productId: f.product.id, contributorId: f.stranger.id });
    const mine = await f.friendCaller.contributions.mine({ limit: 30 });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]!.productTitle).toBe("Headphones");
    expect(mine.items[0]!.c.contributorId).toBe(f.friend.id);
    expect(await f.ownerCaller.contributions.mine({ limit: 30 })).toEqual({ items: [], nextCursor: null });
  });

  test("awaitingMyDecision lists my claims and masks anonymous ones, owner included", async () => {
    const f = await fixture();
    await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 100, isAnonymous: true });
    await f.strangerCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 200 });
    const rows = await f.ownerCaller.contributions.awaitingMyDecision();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.productTitle === "Headphones")).toBe(true);
    expect(rows.filter((r) => r.contributor === null)).toHaveLength(1);
    // Not my list: nothing to decide.
    expect(await f.friendCaller.contributions.awaitingMyDecision()).toEqual([]);
  });

  test("the stored contributor id is kept for anonymous rows (audit)", async () => {
    const f = await fixture();
    const claim = await f.friendCaller.contributions.declareManual({ productId: f.product.id, amountMinor: 100, isAnonymous: true });
    const [row] = await f.db.select().from(contributions).where(and(eq(contributions.productId, f.product.id)));
    expect(row!.id).toBe(claim.id);
    expect(row!.contributorId).toBe(f.friend.id);
    const caller = await makeCaller(f.db, f.friend);
    expect((await caller.contributions.mine({ limit: 10 })).items[0]!.c.isAnonymous).toBe(true);
  });
});
