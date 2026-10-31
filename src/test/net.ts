import { beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { users } from "../db/schema";
import { setTelegramClientForTests } from "../lib/telegram";

/**
 * Keeps every router test off the network. `invoiceLink` and image presigning
 * are faked; rate limiting always allows; no Redis socket is opened.
 *
 * Import this module before anything that imports ioredis or the S3 presigner,
 * so those stubs replace the real clients. Stars invoice calls go through the
 * replaceable `tg` client, including when bot tests imported grammY first.
 */
export interface FakeTelegram {
  invoiceLinks: Array<{
    title: string;
    description: string;
    payload: string;
    currency: string;
    prices: { label: string; amount: number }[];
  }>;
  /** When set, invoice link creation fails the way a Telegram API error would. */
  failInvoiceLink?: Error;
}

export const fakeTelegram: FakeTelegram = { invoiceLinks: [] };

/**
 * Clear captured network fakes before each test in the calling file.
 * Register from every router test file. One shared hook would run only for the
 * first file, and later files would see another file's invoice links.
 */
export function resetFakesBeforeEach() {
  beforeEach(() => {
    fakeTelegram.invoiceLinks.length = 0;
    fakeTelegram.failInvoiceLink = undefined;
  });
}

// Replace the live client. Mocking the `grammy` module does not work once the
// bot tests have imported the real package, and a full module mock removes `Bot`.
setTelegramClientForTests({
  async createInvoiceLink(title, description, payload, _providerToken, currency, prices) {
    if (fakeTelegram.failInvoiceLink) throw fakeTelegram.failInvoiceLink;
    fakeTelegram.invoiceLinks.push({ title, description, payload, currency, prices });
    return `https://t.me/invoice/${payload}`;
  },
});

mock.module("ioredis", () => ({
  default: class FakeRedis {
    status = "ready";
    async ping() {
      return "PONG";
    }
    multi() {
      const chain = {
        incr: () => chain,
        expire: () => chain,
        exec: async () => [[null, 1]],
      };
      return chain;
    }
    disconnect() {}
    quit() {
      return Promise.resolve("OK");
    }
    on() {
      return this;
    }
  },
}));

mock.module("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_client: unknown, cmd: { input: { Key: string; ContentType?: string } }) =>
    `https://s3.example.com/test/${cmd.input.Key}?X-Amz-Signature=fake&Content-Type=${encodeURIComponent(cmd.input.ContentType ?? "")}`,
}));

/** Allow every rate-limited call in tests. */
mock.module("../lib/redis", () => ({
  rateLimit: async () => true,
  // `readyz` would ping this; no test needs it.
  redis: { ping: async () => "PONG" },
}));

export type TestCaller = Awaited<ReturnType<typeof makeCaller>>;

export async function makeCaller(db: DB, user: { id: string }) {
  const { appRouter } = await import("../api/routers");
  const [row] = await db.select().from(users).where(eq(users.id, user.id));
  if (!row) throw new Error(`test caller needs an existing user (${user.id})`);
  return appRouter.createCaller({ db, user: row });
}
