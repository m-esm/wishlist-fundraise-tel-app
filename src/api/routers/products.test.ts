import "../../test/net";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { groupSessions, products, telegramChats, wishlists } from "../../db/schema";
import { contribution, fixture, newProduct, newWishlist, setPremium, user } from "../../test/fixtures";
import { resetFakesBeforeEach } from "../../test/net";
import { testDb } from "../../test/pglite";

resetFakesBeforeEach();

describe("products router", () => {
  test("create stores a manually entered item with defaults", async () => {
    const f = await fixture();
    const p = await f.ownerCaller.products.create({
      wishlistId: f.wishlist.id,
      title: "  Coffee machine ",
      priceMinor: 12999,
      currency: "USD",
      priority: 2,
    });
    expect(p.title).toBe("Coffee machine");
    expect(p.priceMinor).toBe(12999);
    expect(p.currency).toBe("USD");
    expect(p.priority).toBe(2);
    expect(p.status).toBe("active");
    expect(p.position).toBe(1);
  });

  test("create accepts XTR and rejects a currency without a Stars rate", async () => {
    const f = await fixture();
    const stars = await f.ownerCaller.products.create({
      wishlistId: f.wishlist.id,
      title: "Stars goal",
      priceMinor: 500,
      currency: "XTR",
    });
    expect(stars.currency).toBe("XTR");
    await expect(
      f.ownerCaller.products.create({ wishlistId: f.wishlist.id, title: "GBP item", priceMinor: 100, currency: "GBP" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("create validates money and URLs", async () => {
    const f = await fixture();
    const base = { wishlistId: f.wishlist.id, title: "Item", priceMinor: 100, currency: "USD" };
    await expect(f.ownerCaller.products.create({ ...base, priceMinor: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(f.ownerCaller.products.create({ ...base, priceMinor: 1.5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(f.ownerCaller.products.create({ ...base, url: "ftp://x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await f.ownerCaller.products.create({ ...base, url: "https://shop.example/item" })).url).toBe(
      "https://shop.example/item",
    );
  });

  test("create requires ownership: another user gets NOT_FOUND", async () => {
    const f = await fixture();
    await expect(
      f.strangerCaller.products.create({ wishlistId: f.wishlist.id, title: "X", priceMinor: 100, currency: "USD" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("free plan: 5 products per list, FORBIDDEN plan_limit:products_per_wishlist; archived do not count", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await newProduct(f.db, f.wishlist.id, `Item ${i}`);
    const sixth = { wishlistId: f.wishlist.id, title: "Sixth", priceMinor: 100, currency: "USD" };
    await expect(f.ownerCaller.products.create(sixth)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "plan_limit:products_per_wishlist",
    });
    await f.ownerCaller.products.setStatus({ productId: f.product.id, status: "archived" });
    const created = await f.ownerCaller.products.create(sixth);
    expect(created.title).toBe("Sixth");
  });

  test("premium removes the product limit", async () => {
    const f = await fixture();
    await setPremium(f.db, f.owner.id);
    for (let i = 0; i < 8; i++) await newProduct(f.db, f.wishlist.id, `Item ${i}`);
    // 9 active + base product; unarchiving is fine too.
    await f.ownerCaller.products.setStatus({ productId: f.product.id, status: "archived" });
    const back = await f.ownerCaller.products.setStatus({ productId: f.product.id, status: "active" });
    expect(back.status).toBe("active");
  });

  test("create is blocked on an archived list", async () => {
    const f = await fixture();
    await f.ownerCaller.wishlists.archive({ wishlistId: f.wishlist.id });
    await expect(
      f.ownerCaller.products.create({ wishlistId: f.wishlist.id, title: "X", priceMinor: 100, currency: "USD" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("get returns detail, visibility and manual pending totals", async () => {
    const f = await fixture();
    await contribution(f.db, { productId: f.product.id, contributorId: f.friend.id, amountMinor: 200 });
    await contribution(f.db, {
      productId: f.product.id, contributorId: f.stranger.id, status: "awaiting_confirmation", amountMinor: 300,
    });
    const ownerView = await f.ownerCaller.products.get({ productId: f.product.id });
    expect(ownerView.isOwner).toBe(true);
    expect(ownerView.contributorCount).toBe(2);
    expect(ownerView.pendingManualMinor).toBe(300);
    expect(ownerView.activeSessionCount).toBe(0);
    const friendView = await f.friendCaller.products.get({ productId: f.product.id });
    expect(friendView.isOwner).toBe(false);
  });

  test("get hides a product on a private list from non-followers (NOT_FOUND)", async () => {
    const f = await fixture();
    await f.db.update(wishlists).set({ visibility: "private" }).where(eq(wishlists.id, f.wishlist.id));
    await expect(f.strangerCaller.products.get({ productId: f.product.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await f.friendCaller.products.get({ productId: f.product.id })).product.id).toBe(f.product.id);
  });

  test("update recomputes funded when the price drops and restores it when the price grows", async () => {
    const f = await fixture();
    await f.db.update(products).set({ fundedMinor: 600 }).where(eq(products.id, f.product.id));
    const funded = await f.ownerCaller.products.update({ productId: f.product.id, priceMinor: 500 });
    expect(funded.status).toBe("funded");
    const active = await f.ownerCaller.products.update({ productId: f.product.id, priceMinor: 900 });
    expect(active.status).toBe("active");
  });

  test("update locks the currency after the first contribution", async () => {
    const f = await fixture();
    await f.db.update(products).set({ fundedMinor: 300 }).where(eq(products.id, f.product.id));
    await expect(
      f.ownerCaller.products.update({ productId: f.product.id, currency: "EUR" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await f.ownerCaller.products.update({ productId: f.product.id, title: "Renamed" })).title).toBe("Renamed");
  });

  test("update on someone else's product is NOT_FOUND", async () => {
    const f = await fixture();
    await expect(
      f.strangerCaller.products.update({ productId: f.product.id, title: "Hijack" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("setStatus purchased closes open group sessions", async () => {
    const f = await fixture();
    await f.db.insert(telegramChats).values({ chatId: -100500, type: "supergroup", botStatus: "member" });
    await f.db.insert(groupSessions).values({
      telegramChatId: -100500,
      beneficiaryId: f.owner.id,
      createdById: f.friend.id,
      status: "open",
      productId: f.product.id,
    });
    const p = await f.ownerCaller.products.setStatus({ productId: f.product.id, status: "purchased" });
    expect(p.status).toBe("purchased");
    const [s] = await f.db.select().from(groupSessions);
    expect(s!.status).toBe("closed");
    expect(s!.closedAt).not.toBeNull();
  });

  test("setStatus active resolves to funded once the goal is reached", async () => {
    const f = await fixture();
    await f.db.update(products).set({ status: "archived", fundedMinor: 1000 }).where(eq(products.id, f.product.id));
    const p = await f.ownerCaller.products.setStatus({ productId: f.product.id, status: "active" });
    expect(p.status).toBe("funded");
  });

  test("delete is blocked once a contribution exists (CONFLICT), allowed otherwise", async () => {
    const f = await fixture();
    const fresh = await newProduct(f.db, f.wishlist.id, "Fresh");
    expect(await f.ownerCaller.products.delete({ productId: fresh.id })).toEqual({ ok: true });
    await contribution(f.db, { productId: f.product.id, contributorId: f.friend.id, status: "rejected" });
    await expect(f.ownerCaller.products.delete({ productId: f.product.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(f.strangerCaller.products.delete({ productId: f.product.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("reorder only touches products of the named list", async () => {
    const f = await fixture();
    const a = await newProduct(f.db, f.wishlist.id, "A");
    const b = await newProduct(f.db, f.wishlist.id, "B");
    const otherList = await newWishlist(f.db, f.owner.id, "public", "Other");
    const foreign = await newProduct(f.db, otherList.id, "Foreign");
    expect(await f.ownerCaller.products.reorder({ wishlistId: f.wishlist.id, orderedIds: [b.id, a.id] })).toEqual({
      ok: true,
    });
    const pos = async (pid: string) =>
      (await f.db.select().from(products).where(eq(products.id, pid)))[0]!.position;
    expect(await pos(b.id)).toBe(0);
    expect(await pos(a.id)).toBe(1);
    expect(await pos(foreign.id)).toBe(0);
    await expect(
      f.ownerCaller.products.reorder({ wishlistId: f.wishlist.id, orderedIds: [foreign.id] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("presignImage returns a fake signed PUT without network", async () => {
    const f = await fixture();
    const res = await f.ownerCaller.products.presignImage({ contentType: "image/png", contentLength: 2048 });
    expect(res.uploadUrl).toContain("X-Amz-Signature=fake");
    expect(res.publicUrl).toStartWith(`https://cdn.example.com/u/${f.owner.id}/`);
    expect(res.publicUrl).toEndWith(".png");
    await expect(
      f.ownerCaller.products.presignImage({ contentType: "image/gif" as "image/png", contentLength: 10 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("recentlyFundedFeed lists funded items of accepted followees only, plus a profile variant", async () => {
    const f = await fixture();
    await f.db.update(products).set({ status: "funded", fundedAt: new Date() }).where(eq(products.id, f.product.id));
    const stranger = await user(f.db, { firstName: "Loner" });
    const strangerList = await newWishlist(f.db, stranger.id, "public");
    await f.db.insert(products).values({
      wishlistId: strangerList.id, title: "Not followed", priceMinor: 100, currency: "USD",
      status: "funded", fundedAt: new Date(),
    });
    const feed = await f.friendCaller.products.recentlyFundedFeed();
    expect(feed.map((p) => p.title)).toEqual(["Headphones"]);
    expect(feed[0]!.ownerId).toBe(f.owner.id);
    // Profile screen: any public funded item of one user.
    await f.db.insert(products).values({
      wishlistId: strangerList.id, title: "Public too", priceMinor: 100, currency: "USD",
      status: "funded", fundedAt: new Date(),
    });
    const profile = await f.strangerCaller.products.recentlyFundedFeed({ userId: stranger.id });
    expect(profile.map((p) => p.title).sort()).toEqual(["Not followed", "Public too"]);
  });

  test("recentlyFundedFeed never lists a private list", async () => {
    const db = await testDb();
    const owner = await user(db, { firstName: "O", username: "o" });
    const viewer = await user(db, { firstName: "V", username: "v" });
    const list = await newWishlist(db, owner.id, "private");
    await db.insert(products).values({
      wishlistId: list.id, title: "Secret", priceMinor: 100, currency: "USD", status: "funded", fundedAt: new Date(),
    });
    const { makeCaller } = await import("../../test/net");
    const caller = await makeCaller(db, viewer);
    expect(await caller.products.recentlyFundedFeed({ userId: owner.id })).toEqual([]);
  });
});
