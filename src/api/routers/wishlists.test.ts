import "../../test/net";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { follows, products, wishlists } from "../../db/schema";
import { fixture, newProduct, newWishlist, setPremium } from "../../test/fixtures";
import { resetFakesBeforeEach } from "../../test/net";

resetFakesBeforeEach();

const isoDay = "2030-06-01T00:00:00.000Z";

describe("wishlists router", () => {
  test("create defaults to public and appends to the owner's position order", async () => {
    const f = await fixture();
    const second = await f.friendCaller.wishlists.create({ title: "  Wedding  " });
    expect(second.title).toBe("Wedding");
    expect(second.visibility).toBe("public");
    expect((await f.friendCaller.users.me()).limits.publicWishlists).toBe(1);
    const list = await f.friendCaller.wishlists.list();
    expect(list.map((r) => r.wishlist.id)).toEqual([second.id]);
  });

  test("free plan: 1 public + 1 private list, FORBIDDEN plan_limit:*", async () => {
    const f = await fixture(); // owner already has one public list
    await expect(f.ownerCaller.wishlists.create({ title: "Second" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "plan_limit:public_wishlists",
    });
    const priv = await f.ownerCaller.wishlists.create({ title: "Private", visibility: "private" });
    expect(priv.visibility).toBe("private");
    await expect(
      f.ownerCaller.wishlists.create({ title: "Private 2", visibility: "private" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "plan_limit:private_wishlists" });
  });

  test("archived lists do not count toward the limit", async () => {
    const f = await fixture();
    await f.ownerCaller.wishlists.archive({ wishlistId: f.wishlist.id });
    const fresh = await f.ownerCaller.wishlists.create({ title: "Fresh" });
    expect(fresh.id).not.toBe(f.wishlist.id);
  });

  test("premium is unlimited", async () => {
    const f = await fixture();
    await setPremium(f.db, f.owner.id);
    for (const visibility of ["public", "public", "private", "private"] as const) {
      await f.ownerCaller.wishlists.create({ title: `L ${visibility}`, visibility });
    }
    expect((await f.ownerCaller.wishlists.list()).length).toBe(5);
  });

  test("update: making a list private is subject to the private limit", async () => {
    const f = await fixture();
    const other = await newWishlist(f.db, f.owner.id, "public", "Other");
    await f.ownerCaller.wishlists.update({ wishlistId: f.wishlist.id, visibility: "private", emoji: "🎁" });
    const [row] = await f.db.select().from(wishlists).where(eq(wishlists.id, f.wishlist.id));
    expect(row!.visibility).toBe("private");
    expect(row!.emoji).toBe("🎁");
    // A second private list breaches the free limit.
    await expect(
      f.ownerCaller.wishlists.update({ wishlistId: other.id, visibility: "private" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "plan_limit:private_wishlists" });
    // Keeping the visibility is not a "change" and is always allowed.
    await f.ownerCaller.wishlists.update({ wishlistId: other.id, visibility: "public", title: "Renamed" });
  });

  test("update accepts an ISO event date and clears it with null", async () => {
    const f = await fixture();
    const dated = await f.ownerCaller.wishlists.update({ wishlistId: f.wishlist.id, eventDate: isoDay });
    expect(dated.eventDate?.toISOString()).toBe(isoDay);
    const cleared = await f.ownerCaller.wishlists.update({ wishlistId: f.wishlist.id, eventDate: null });
    expect(cleared.eventDate).toBeNull();
  });

  test("another user cannot update, archive or reorder my list (NOT_FOUND)", async () => {
    const f = await fixture();
    await expect(
      f.strangerCaller.wishlists.update({ wishlistId: f.wishlist.id, title: "Hijack" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.strangerCaller.wishlists.archive({ wishlistId: f.wishlist.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.strangerCaller.wishlists.reorder({ orderedIds: [f.wishlist.id] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("an archived list is read-only", async () => {
    const f = await fixture();
    await f.ownerCaller.wishlists.archive({ wishlistId: f.wishlist.id });
    await expect(
      f.ownerCaller.wishlists.update({ wishlistId: f.wishlist.id, title: "X" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Archiving twice is idempotent.
    expect(await f.ownerCaller.wishlists.archive({ wishlistId: f.wishlist.id })).toEqual({ ok: true });
  });

  test("private visibility: NOT_FOUND for non-followers, readable for accepted followers", async () => {
    const f = await fixture();
    await f.db.update(wishlists).set({ visibility: "private" }).where(eq(wishlists.id, f.wishlist.id));
    expect((await f.friendCaller.wishlists.get({ wishlistId: f.wishlist.id })).wishlist.id).toBe(f.wishlist.id);
    await expect(f.strangerCaller.wishlists.get({ wishlistId: f.wishlist.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await f.strangerCaller.wishlists.list({ userId: f.owner.id })).toEqual([]);
    expect((await f.friendCaller.wishlists.list({ userId: f.owner.id })).length).toBe(1);
    expect((await f.ownerCaller.wishlists.list({ userId: f.owner.id })).length).toBe(1);
  });

  test("a pending follower cannot read a private list", async () => {
    const f = await fixture();
    await f.db.update(follows).set({ status: "pending", respondedAt: null })
      .where(eq(follows.followerId, f.friend.id));
    await f.db.update(wishlists).set({ visibility: "private" }).where(eq(wishlists.id, f.wishlist.id));
    await expect(f.friendCaller.wishlists.get({ wishlistId: f.wishlist.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("archived lists are hidden from the owner's list output but readable via get", async () => {
    const f = await fixture();
    await f.ownerCaller.wishlists.archive({ wishlistId: f.wishlist.id });
    expect(await f.ownerCaller.wishlists.list()).toEqual([]);
    expect((await f.ownerCaller.wishlists.get({ wishlistId: f.wishlist.id })).wishlist.id).toBe(f.wishlist.id);
    await expect(f.friendCaller.wishlists.get({ wishlistId: f.wishlist.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("get counts items and hides archived products from readers", async () => {
    const f = await fixture();
    const gone = await newProduct(f.db, f.wishlist.id, "Gone");
    await f.db.update(products).set({ status: "archived" }).where(eq(products.id, gone.id));
    const owner = await f.ownerCaller.wishlists.get({ wishlistId: f.wishlist.id });
    expect(owner.products.map((p) => p.title)).toEqual(["Headphones", "Gone"]);
    expect(owner.isOwner).toBe(true);
    const reader = await f.friendCaller.wishlists.get({ wishlistId: f.wishlist.id });
    expect(reader.products.map((p) => p.title)).toEqual(["Headphones"]);
    expect(reader.isOwner).toBe(false);
  });

  test("list returns item and funded counts", async () => {
    const f = await fixture();
    await newProduct(f.db, f.wishlist.id, "Second");
    const [row] = await f.ownerCaller.wishlists.list();
    expect(row!.itemCount).toBe(2);
    expect(row!.fundedCount).toBe(0);
  });

  test("reorder accepts only my lists, in any order", async () => {
    const f = await fixture();
    const other = await newWishlist(f.db, f.owner.id, "public", "Other");
    expect(await f.ownerCaller.wishlists.reorder({ orderedIds: [other.id, f.wishlist.id] })).toEqual({ ok: true });
    const rows = await f.db.select().from(wishlists).orderBy(wishlists.position);
    expect(rows.map((r) => r.id)).toEqual([other.id, f.wishlist.id]);
    await expect(
      f.ownerCaller.wishlists.reorder({ orderedIds: [f.wishlist.id, "00000000-0000-4000-8000-000000000000"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
