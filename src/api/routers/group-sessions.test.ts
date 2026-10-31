import "../../test/net";
import { describe, expect, test } from "bun:test";
import { groupSessions, telegramChats } from "../../db/schema";
import { contribution, fixture, newProduct, newWishlist, setPremium, user } from "../../test/fixtures";
import { resetFakesBeforeEach } from "../../test/net";
import { testDb } from "../../test/pglite";
import { appRouter } from "../routers";

resetFakesBeforeEach();

async function sessionFor(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<typeof groupSessions.$inferInsert> = {},
  chatId = -100777,
) {
  await f.db.insert(telegramChats).values({
    chatId,
    type: "supergroup",
    title: "Family",
    botStatus: "member",
  }).onConflictDoNothing();
  const [s] = await f.db.insert(groupSessions).values({
    telegramChatId: chatId,
    beneficiaryId: f.owner.id,
    createdById: f.friend.id,
    status: "open",
    productId: f.product.id,
    ...overrides,
  }).returning();
  return s!;
}

describe("group-sessions router", () => {
  test("get returns the session, chat title, product and beneficiary", async () => {
    const f = await fixture();
    const s = await sessionFor(f);
    const res = await f.strangerCaller.groupSessions.get({ sessionId: s.id });
    expect(res.session.id).toBe(s.id);
    expect(res.session.status).toBe("open");
    expect(res.chatTitle).toBe("Family");
    expect(res.product?.id).toBe(f.product.id);
    expect(res.beneficiary.id).toBe(f.owner.id);
    expect(res.beneficiary.firstName).toBe("Owner");
  });

  test("get with an unknown session id is NOT_FOUND", async () => {
    const f = await fixture();
    await expect(
      f.friendCaller.groupSessions.get({ sessionId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("get omits the product while the session is still voting", async () => {
    const f = await fixture();
    const s = await sessionFor(f, { status: "voting", productId: null, candidateProductIds: [f.product.id] });
    const res = await f.friendCaller.groupSessions.get({ sessionId: s.id });
    expect(res.product).toBeNull();
    expect(res.session.candidateProductIds).toEqual([f.product.id]);
  });

  test("leaderboard sums confirmed contributions per contributor, top first", async () => {
    const f = await fixture();
    const s = await sessionFor(f);
    const big = await user(f.db, { firstName: "Big", username: "big" });
    await contribution(f.db, { productId: f.product.id, contributorId: f.friend.id, amountMinor: 100, groupSessionId: s.id });
    await contribution(f.db, { productId: f.product.id, contributorId: f.friend.id, amountMinor: 50, groupSessionId: s.id });
    await contribution(f.db, { productId: f.product.id, contributorId: big.id, amountMinor: 400, groupSessionId: s.id });
    // Not confirmed or not in this session: ignored.
    await contribution(f.db, {
      productId: f.product.id, contributorId: big.id, amountMinor: 999, status: "awaiting_confirmation", groupSessionId: s.id,
    });
    await contribution(f.db, { productId: f.product.id, contributorId: big.id, amountMinor: 999 });
    const rows = await f.strangerCaller.groupSessions.leaderboard({ sessionId: s.id });
    expect(rows.map((r) => [r.userId, r.totalMinor])).toEqual([
      [big.id, 400],
      [f.friend.id, 150],
    ]);
    expect(rows[1]!.name).toBe("@friend");
  });

  test("leaderboard masks anonymous contributors for everyone, including the owner and themselves", async () => {
    const f = await fixture();
    const s = await sessionFor(f);
    await contribution(f.db, { productId: f.product.id, contributorId: f.friend.id, amountMinor: 300, groupSessionId: s.id });
    await contribution(f.db, {
      productId: f.product.id, contributorId: f.friend.id, amountMinor: 200, groupSessionId: s.id, isAnonymous: true,
    });
    await contribution(f.db, {
      productId: f.product.id, contributorId: f.stranger.id, amountMinor: 100, groupSessionId: s.id, isAnonymous: true,
    });
    const rows = await f.ownerCaller.groupSessions.leaderboard({ sessionId: s.id });
    const anon = rows.find((r) => r.name === "Anonymous");
    expect(anon).toEqual({ userId: null, name: "Anonymous", totalMinor: 300 });
    expect(rows.find((r) => r.userId === f.friend.id)!.totalMinor).toBe(300);
    const own = await f.friendCaller.groupSessions.leaderboard({ sessionId: s.id });
    expect(own.find((r) => r.name === "Anonymous")!.totalMinor).toBe(300);
  });

  test("an unknown session has no leaderboard (NOT_FOUND)", async () => {
    const f = await fixture();
    await expect(
      f.friendCaller.groupSessions.leaderboard({ sessionId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a voting session's leaderboard is limited to the starter and beneficiary", async () => {
    const f = await fixture();
    const s = await sessionFor(f, { status: "voting", productId: null });
    expect(await f.ownerCaller.groupSessions.leaderboard({ sessionId: s.id })).toEqual([]); // beneficiary
    expect(await f.friendCaller.groupSessions.leaderboard({ sessionId: s.id })).toEqual([]); // starter
    await expect(f.strangerCaller.groupSessions.leaderboard({ sessionId: s.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("forMe lists the sessions raising money for me with product titles", async () => {
    const f = await fixture();
    const open = await sessionFor(f);
    await f.db.insert(telegramChats).values({ chatId: -100888, type: "group", title: "Work", botStatus: "member" });
    await f.db.insert(groupSessions).values({
      telegramChatId: -100888,
      beneficiaryId: f.owner.id,
      createdById: f.friend.id,
      status: "closed",
      productId: f.product.id,
    });
    const rows = await f.ownerCaller.groupSessions.forMe();
    expect(rows.map((r) => r.session.id)).toEqual([open.id]);
    expect(rows[0]!.productTitle).toBe("Headphones");
    expect(rows[0]!.chatTitle).toBe("Family");
    // Someone else's list is private.
    expect(await f.friendCaller.groupSessions.forMe()).toEqual([]);
  });

  test("forMe includes voting, open and completed sessions only", async () => {
    const f = await fixture();
    for (const [i, status] of (["voting", "open", "completed", "closed", "cancelled"] as const).entries()) {
      await sessionFor(f, {
        status,
        productId: status === "voting" || status === "cancelled" ? null : f.product.id,
      }, -101000 - i);
    }
    const rows = await f.ownerCaller.groupSessions.forMe();
    expect(rows.map((r) => r.session.status).sort()).toEqual(["completed", "open", "voting"]);
  });

  test("every handler requires auth (UNAUTHORIZED)", async () => {
    const db = await testDb();
    const caller = appRouter.createCaller({ db, initData: null, authError: null });
    await expect(caller.groupSessions.forMe()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.groupSessions.get({ sessionId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("fixtures keep sessions isolated per product and list", async () => {
    const f = await fixture();
    const list = await newWishlist(f.db, f.owner.id);
    const p2 = await newProduct(f.db, list.id, "Second gift");
    await setPremium(f.db, f.owner.id);
    const s = await sessionFor(f, { productId: p2.id });
    const res = await f.ownerCaller.groupSessions.get({ sessionId: s.id });
    expect(res.product?.title).toBe("Second gift");
    expect(res.beneficiary.id).toBe(f.owner.id);
  });
});
