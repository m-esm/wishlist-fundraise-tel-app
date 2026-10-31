import "../../test/net";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import { user } from "../../test/fixtures";
import { makeCaller, resetFakesBeforeEach } from "../../test/net";
import { testDb } from "../../test/pglite";
import { appRouter } from "../routers";

resetFakesBeforeEach();

const anyId = "00000000-0000-4000-8000-000000000000";

describe("auth router", () => {
  test("session refreshes the stored profile from initData", async () => {
    const db = await testDb();
    const stored = await user(db, { firstName: "Old", username: "rename_me" });
    const caller = appRouter.createCaller({
      db,
      initData: {
        user: { id: stored.telegramId, first_name: "New", username: "renamed" },
        authDate: new Date(),
      },
      authError: null,
    });
    const res = await caller.auth.session();
    expect(res.user.id).toBe(stored.id);
    expect(res.user.firstName).toBe("New");
    expect(res.user.username).toBe("renamed");
    expect(res.startParam).toBeNull();
    expect(res.chatType).toBeNull();
    const [after] = await db.select().from(users).where(eq(users.id, stored.id));
    expect(after!.firstName).toBe("New");
  });

  test("session parses start_param and reports the chat type", async () => {
    const db = await testDb();
    const caller = appRouter.createCaller({
      db,
      initData: {
        user: { id: 7001, first_name: "Fresh" },
        authDate: new Date(),
        startParam: `w_${anyId}`,
        chatType: "supergroup",
      },
      authError: null,
    });
    const res = await caller.auth.session();
    expect(res.startParam).toEqual({ kind: "wishlist", wishlistId: anyId });
    expect(res.chatType).toBe("supergroup");
    // First call creates the user row.
    const [created] = await db.select().from(users).where(eq(users.telegramId, 7001));
    expect(created!.firstName).toBe("Fresh");
  });

  test("session works with the test context (no initData)", async () => {
    const db = await testDb();
    const me = await user(db);
    const caller = await makeCaller(db, me);
    const res = await caller.auth.session();
    expect(res.user.id).toBe(me.id);
    expect(res.startParam).toBeNull();
  });

  test("session opens the Premium screen from start_param premium", async () => {
    const db = await testDb();
    const caller = appRouter.createCaller({
      db,
      initData: { user: { id: 7003, first_name: "X" }, authDate: new Date(), startParam: "premium" },
      authError: null,
    });
    expect((await caller.auth.session()).startParam).toEqual({ kind: "premium" });
  });

  test("an unknown start_param is ignored", async () => {
    const db = await testDb();
    const caller = appRouter.createCaller({
      db,
      initData: { user: { id: 7002, first_name: "X" }, authDate: new Date(), startParam: "nonsense" },
      authError: null,
    });
    expect((await caller.auth.session()).startParam).toBeNull();
  });

  test("missing or invalid initData is UNAUTHORIZED", async () => {
    const db = await testDb();
    for (const authError of [null, "bad signature", "initData expired"]) {
      const caller = appRouter.createCaller({ db, initData: null, authError });
      await expect(caller.auth.session()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    await expect(
      appRouter.createCaller({ db, initData: null, authError: "bad signature" }).users.me(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "bad signature" });
  });
});
