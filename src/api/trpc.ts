import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { db, type DB } from "../db/client";
import { users } from "../db/schema";
import { env } from "../env";
import { InitDataError, validateInitData, type InitData } from "../lib/init-data";
import { rateLimit } from "../lib/redis";
import { ContributionError } from "../services/contributions";
import { upsertTelegramUser } from "../services/users";

/**
 * Auth: every request carries the raw Mini App initData:
 *
 *   Authorization: tma <window.Telegram.WebApp.initData>
 *
 * It is HMAC-verified on each call (cheap, stateless, no session store).
 * auth_date older than INIT_DATA_MAX_AGE_SECONDS is rejected; the client
 * should reload the Mini App to get fresh initData.
 */
export async function createContext({ req }: FetchCreateContextFnOptions) {
  const header = req.headers.get("authorization") ?? "";
  let initData: InitData | null = null;
  let authError: string | null = null;
  if (header.startsWith("tma ")) {
    try {
      initData = validateInitData(header.slice(4), env.BOT_TOKEN, env.INIT_DATA_MAX_AGE_SECONDS);
    } catch (e) {
      authError = e instanceof InitDataError ? e.message : "invalid initData";
    }
  }
  return { db: db as DB, initData, authError };
}

/** Request context (what createContext returns, before auth). */
export interface RequestContext {
  db: DB;
  initData: InitData | null;
  authError: string | null;
}

/**
 * Test-only context: a PGlite database and the already-stored user, with no
 * initData, so auth never runs (no rate limit, no upsert). Detected by the
 * absence of the `initData` key, which createContext always sets.
 */
export interface TestContext {
  db: DB;
  user: typeof users.$inferSelect;
}

const t = initTRPC.context<RequestContext | TestContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape }) => shape,
});

export const router = t.router;

/** Maps domain errors to tRPC codes. */
const errorMapping = t.middleware(async ({ next }) => {
  const res = await next();
  if (!res.ok && res.error.cause instanceof ContributionError) {
    const msg = res.error.cause.message;
    throw new TRPCError({
      code: msg === "forbidden" ? "FORBIDDEN" : msg.endsWith("not found") ? "NOT_FOUND" : "CONFLICT",
      message: msg,
    });
  }
  return res;
});

type AuthedContext = RequestContext & { user: typeof users.$inferSelect };
type TestAuthedContext = RequestContext & TestContext;

function testUserOf(ctx: RequestContext | TestContext): typeof users.$inferSelect | null {
  return "initData" in ctx ? null : ctx.user;
}

export const publicProcedure = t.procedure.use(errorMapping);

/** Requires valid initData; resolves (and lazily creates) the DB user. */
export const authedProcedure = publicProcedure
  .use(async ({ ctx, next }) => {
    const test = testUserOf(ctx);
    if (test) return next({ ctx: { db: ctx.db as DB, initData: null, user: test } });

    const request = ctx as RequestContext;
    if (!request.initData) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: request.authError ?? "missing initData" });
    }
    const tgUser = request.initData.user;
    if (!(await rateLimit(`u:${tgUser.id}`, env.RATE_LIMIT_PER_MINUTE))) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
    }
    const [existing] = await request.db.select().from(users).where(eq(users.telegramId, tgUser.id));
    const user = existing ?? (await upsertTelegramUser(request.db, tgUser));
    return next({ ctx: { db: request.db, initData: request.initData, user } });
  })
  .use(({ ctx, next }) => next({ ctx: ctx as unknown as AuthedContext | TestAuthedContext }));
