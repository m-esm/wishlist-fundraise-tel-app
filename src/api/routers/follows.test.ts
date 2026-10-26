import "../../test/net";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { follows, notificationOutbox, users, wishlists } from "../../db/schema";
import { fixture, user } from "../../test/fixtures";
import { makeCaller, resetFakesBeforeEach } from "../../test/net";

resetFakesBeforeEach();

const followRow = async (db: Awaited<ReturnType<typeof fixture>>["db"], followerId: string, followeeId: string) =>
  (await db.select().from(follows).where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId))))[0];

describe("follows router", () => {
  test("follow creates a pending request and queues a DM to the owner", async () => {
    const f = await fixture();
    const target = await user(f.db, { firstName: "Target" });
    expect(await f.strangerCaller.follows.follow({ userId: target.id })).toEqual({ status: "pending" });
    expect((await followRow(f.db, f.stranger.id, target.id))!.status).toBe("pending");
    const outbox = await f.db.select().from(notificationOutbox);
    expect(outbox.map((o) => o.kind)).toEqual(["follow_request"]);
    expect(outbox[0]!.userId).toBe(target.id);
    expect(outbox[0]!.payload).toEqual({ followerId: f.stranger.id });
    // Repeating the request does not create a second DM.
    expect(await f.strangerCaller.follows.follow({ userId: target.id })).toEqual({ status: "pending" });
    expect((await f.db.select().from(notificationOutbox)).length).toBe(1);
  });

  test("auto-accept users get an accepted follow immediately", async () => {
    const f = await fixture();
    const target = await user(f.db, { firstName: "Open", autoAcceptFollows: true });
    expect(await f.strangerCaller.follows.follow({ userId: target.id })).toEqual({ status: "accepted" });
    const row = await followRow(f.db, f.stranger.id, target.id);
    expect(row!.status).toBe("accepted");
    expect(row!.respondedAt).not.toBeNull();
    expect(await f.db.select().from(notificationOutbox)).toEqual([]);
  });

  test("following an accepted user again and after a rejection stays quiet", async () => {
    const f = await fixture();
    // friend already follows owner (accepted)
    expect(await f.friendCaller.follows.follow({ userId: f.owner.id })).toEqual({ status: "accepted" });
    const target = await user(f.db, { firstName: "Refuser" });
    await f.db.insert(follows).values({
      followerId: f.stranger.id, followeeId: target.id, status: "rejected", respondedAt: new Date(),
    });
    expect(await f.strangerCaller.follows.follow({ userId: target.id })).toEqual({ status: "pending" });
    expect((await followRow(f.db, f.stranger.id, target.id))!.status).toBe("rejected");
    expect(await f.db.select().from(notificationOutbox)).toEqual([]);
  });

  test("a rejected request stays rejected through cancel and a later follow", async () => {
    const f = await fixture();
    const target = await user(f.db, { firstName: "Refuser" });
    await f.strangerCaller.follows.follow({ userId: target.id });
    expect((await followRow(f.db, f.stranger.id, target.id))!.status).toBe("pending");
    // The target owns the request, so the target declines it.
    const targetCaller = await makeCaller(f.db, target);
    expect(await targetCaller.follows.respond({ followerId: f.stranger.id, accept: false })).toEqual({
      status: "rejected",
    });
    expect((await followRow(f.db, f.stranger.id, target.id))!.status).toBe("rejected");
    // The client shows "Cancel follow request" for a rejected edge.
    expect(await f.strangerCaller.follows.unfollow({ userId: target.id })).toEqual({ ok: true });
    // The rejection is preserved, so cancel does not erase the owner's answer.
    expect((await followRow(f.db, f.stranger.id, target.id))!.status).toBe("rejected");
    // A later request stays quiet: still rejected, and no new DM.
    expect(await f.strangerCaller.follows.follow({ userId: target.id })).toEqual({ status: "pending" });
    expect((await followRow(f.db, f.stranger.id, target.id))!.status).toBe("rejected");
    // Only the first request sent a DM. Cancel and the later request send none.
    const outbox = await f.db.select().from(notificationOutbox);
    expect(outbox.map((o) => o.kind)).toEqual(["follow_request"]);
  });

  test("unfollow after acceptance removes the edge and the counts", async () => {
    const f = await fixture();
    expect((await f.friendCaller.users.profile({ userId: f.owner.id })).followStatus).toBe("accepted");
    expect(await f.friendCaller.follows.unfollow({ userId: f.owner.id })).toEqual({ ok: true });
    expect(await followRow(f.db, f.friend.id, f.owner.id)).toBeUndefined();
    const after = await f.friendCaller.users.profile({ userId: f.owner.id });
    expect(after.followStatus).toBeNull();
    expect(after.counts.followers).toBe(0);
  });

  test("cannot follow yourself or an unknown user", async () => {
    const f = await fixture();
    await expect(f.ownerCaller.follows.follow({ userId: f.owner.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.ownerCaller.follows.follow({ userId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("respond accepts or rejects a pending request; only once", async () => {
    const f = await fixture();
    await f.strangerCaller.follows.follow({ userId: f.owner.id });
    expect(await f.ownerCaller.follows.respond({ followerId: f.stranger.id, accept: true })).toEqual({
      status: "accepted",
    });
    expect((await followRow(f.db, f.stranger.id, f.owner.id))!.status).toBe("accepted");
    const outbox = await f.db.select().from(notificationOutbox);
    expect(outbox.some((o) => o.kind === "follow_accepted" && o.userId === f.stranger.id)).toBe(true);
    await expect(f.ownerCaller.follows.respond({ followerId: f.stranger.id, accept: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("respond rejects a request with rejected", async () => {
    const f = await fixture();
    await f.strangerCaller.follows.follow({ userId: f.owner.id });
    expect(await f.ownerCaller.follows.respond({ followerId: f.stranger.id, accept: false })).toEqual({
      status: "rejected",
    });
    expect((await followRow(f.db, f.stranger.id, f.owner.id))!.status).toBe("rejected");
  });

  test("respond on a request that does not exist is NOT_FOUND", async () => {
    const f = await fixture();
    await expect(
      f.ownerCaller.follows.respond({ followerId: f.stranger.id, accept: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a pending follow lets the follower read a private list only after acceptance", async () => {
    const f = await fixture();
    await f.db.update(follows).set({ status: "pending" }).where(eq(follows.followerId, f.friend.id));
    await f.db.update(wishlists).set({ visibility: "private" }).where(eq(wishlists.id, f.wishlist.id));
    await expect(f.friendCaller.wishlists.get({ wishlistId: f.wishlist.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await f.ownerCaller.follows.respond({ followerId: f.friend.id, accept: true });
    expect((await f.friendCaller.wishlists.get({ wishlistId: f.wishlist.id })).wishlist.id).toBe(f.wishlist.id);
  });

  test("unfollow and removeFollower delete the edge", async () => {
    const f = await fixture();
    expect(await f.friendCaller.follows.unfollow({ userId: f.owner.id })).toEqual({ ok: true });
    expect(await followRow(f.db, f.friend.id, f.owner.id)).toBeUndefined();
    await f.strangerCaller.follows.follow({ userId: f.owner.id });
    await f.ownerCaller.follows.respond({ followerId: f.stranger.id, accept: true });
    expect(await f.ownerCaller.follows.removeFollower({ followerId: f.stranger.id })).toEqual({ ok: true });
    expect(await followRow(f.db, f.stranger.id, f.owner.id)).toBeUndefined();
    // removeFollower only removes edges where I am the followee.
    await f.friendCaller.follows.follow({ userId: f.owner.id });
    expect(await f.friendCaller.follows.removeFollower({ followerId: f.friend.id })).toEqual({ ok: true });
    expect((await followRow(f.db, f.friend.id, f.owner.id))!.status).toBe("pending");
  });

  test("incomingRequests, followers and following show only my graph", async () => {
    const f = await fixture();
    await f.strangerCaller.follows.follow({ userId: f.owner.id });
    const incoming = await f.ownerCaller.follows.incomingRequests();
    expect(incoming.map((r) => r.user.id)).toEqual([f.stranger.id]);
    expect(incoming[0]!.user.username).toBe("stranger");
    const followers = await f.ownerCaller.follows.followers();
    expect(followers.map((u) => u.id)).toEqual([f.friend.id]);
    const following = await f.friendCaller.follows.following();
    expect(following.map((u) => u.id)).toEqual([f.owner.id]);
    // A stranger with no graph sees nothing.
    expect(await f.friendCaller.follows.incomingRequests()).toEqual([]);
    expect((await f.db.select().from(users)).length).toBe(3);
  });
});
