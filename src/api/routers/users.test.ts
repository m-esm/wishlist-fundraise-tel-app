import "../../test/net";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { follows, users } from "../../db/schema";
import { fixture, newWishlist, setPremium, user } from "../../test/fixtures";
import { resetFakesBeforeEach } from "../../test/net";
import { testDb } from "../../test/pglite";

resetFakesBeforeEach();

describe("users router", () => {
  test("me returns the user, plan and JSON-safe limits", async () => {
    const f = await fixture();
    const free = await f.ownerCaller.users.me();
    expect(free.user.id).toBe(f.owner.id);
    expect(free.plan).toBe("free");
    expect(free.limits).toEqual({ publicWishlists: 1, privateWishlists: 1, productsPerWishlist: 5 });

    await setPremium(f.db, f.owner.id);
    const premium = await f.ownerCaller.users.me();
    expect(premium.plan).toBe("premium");
    // null = unlimited (Infinity is not valid JSON)
    expect(premium.limits).toEqual({ publicWishlists: null, privateWishlists: null, productsPerWishlist: null });
  });

  test("an expired premium subscription is free again", async () => {
    const f = await fixture();
    await setPremium(f.db, f.owner.id, new Date(Date.now() - 1000));
    expect((await f.ownerCaller.users.me()).plan).toBe("free");
  });

  test("updateMe writes the editable fields only", async () => {
    const f = await fixture();
    const updated = await f.ownerCaller.users.updateMe({
      bio: "Hi",
      autoAcceptFollows: true,
      notificationsEnabled: false,
      defaultCurrency: "EUR",
    });
    expect(updated.bio).toBe("Hi");
    expect(updated.autoAcceptFollows).toBe(true);
    expect(updated.notificationsEnabled).toBe(false);
    expect(updated.defaultCurrency).toBe("EUR");
    expect(updated.telegramId).toBe(f.owner.telegramId);
  });

  test("updateMe rejects a currency without a Stars rate and a non-ISO code", async () => {
    const f = await fixture();
    await expect(f.ownerCaller.users.updateMe({ defaultCurrency: "GBP" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(f.ownerCaller.users.updateMe({ defaultCurrency: "usd" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect((await f.ownerCaller.users.updateMe({ defaultCurrency: "XTR" })).defaultCurrency).toBe("XTR");
  });

  test("profile resolves by id and username and reports the relationship", async () => {
    const f = await fixture();
    await newWishlist(f.db, f.owner.id, "private");
    const byId = await f.friendCaller.users.profile({ userId: f.owner.id });
    expect(byId.isMe).toBe(false);
    expect(byId.followStatus).toBe("accepted");
    expect(byId.counts).toEqual({ followers: 1, following: 0, wishlists: 2 });

    const byName = await f.strangerCaller.users.profile({ username: "@owner" });
    expect(byName.user.id).toBe(f.owner.id);
    expect(byName.followStatus).toBeNull();
    expect(byName.followsMe).toBe(false);

    const me = await f.ownerCaller.users.profile({ userId: f.owner.id });
    expect(me.isMe).toBe(true);
    expect(me.followStatus).toBeNull();
  });

  test("profile reports a pending request and a follow back", async () => {
    const f = await fixture();
    const other = await user(f.db, { firstName: "Other", username: "other" });
    await f.db.insert(follows).values({ followerId: f.owner.id, followeeId: other.id, status: "pending" });
    await f.db.insert(follows).values({ followerId: other.id, followeeId: f.owner.id, status: "accepted" });
    const res = await f.ownerCaller.users.profile({ userId: other.id });
    expect(res.followStatus).toBe("pending");
    expect(res.followsMe).toBe(true);
  });

  test("profile reports a rejected request as pending", async () => {
    const f = await fixture();
    const other = await user(f.db, { firstName: "Other", username: "other" });
    await f.db.insert(follows).values({ followerId: f.owner.id, followeeId: other.id, status: "rejected" });
    // follows.follow hides the rejection: it returns "pending" and stays quiet.
    expect(await f.ownerCaller.follows.follow({ userId: other.id })).toEqual({ status: "pending" });
    const res = await f.ownerCaller.users.profile({ userId: other.id });
    expect(res.followStatus).toBe("pending");
  });

  test("profile for an unknown user is NOT_FOUND", async () => {
    const f = await fixture();
    await expect(f.ownerCaller.users.profile({ username: "nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.ownerCaller.users.profile({ userId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("search is prefix-based, excludes me, and escapes LIKE wildcards", async () => {
    const f = await fixture();
    const anna = await user(f.db, { firstName: "Annabel", username: "anna" });
    await user(f.db, { firstName: "Zoe", username: "zoe" });
    const res = await f.ownerCaller.users.search({ query: "ann", limit: 10 });
    expect(res.map((u) => u.id)).toEqual([anna.id]);
    // "own" matches the owner's username, but I am excluded.
    expect(await f.ownerCaller.users.search({ query: "own", limit: 10 })).toEqual([]);
    // "%" would match everything if it were not escaped.
    expect(await f.ownerCaller.users.search({ query: "%%", limit: 10 })).toEqual([]);
    // Too short for any search.
    await expect(f.ownerCaller.users.search({ query: "a", limit: 10 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("setPlan is a NOT_IMPLEMENTED stub", async () => {
    const f = await fixture();
    await expect(f.ownerCaller.users.setPlan({ plan: "premium" })).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "Premium coming soon",
    });
    const [row] = await f.db.select().from(users).where(eq(users.id, f.owner.id));
    expect(row!.id).toBe(f.owner.id);
  });
});
