import { Api } from "grammy";
import { env } from "../env";

/**
 * Invoice client used by the API. Tests replace it so a bot suite that has
 * already imported real grammY cannot leave `createInvoiceLink` pointed at Telegram.
 */
export type InvoiceLinkClient = {
  createInvoiceLink: (
    title: string,
    description: string,
    payload: string,
    providerToken: string,
    currency: string,
    prices: { label: string; amount: number }[],
    other?: { photo_url?: string },
  ) => Promise<string>;
};

let invoiceClient: InvoiceLinkClient = new Api(env.BOT_TOKEN);

/** Test hook. Production code does not call this. */
export function setTelegramClientForTests(client: InvoiceLinkClient) {
  invoiceClient = client;
}

/** Bot API client usable from any process (no update handling). */
export const tg: InvoiceLinkClient = {
  createInvoiceLink: (...args) => invoiceClient.createInvoiceLink(...args),
};

/** https://t.me/<bot>/<app>?startapp=<param> — opens the Mini App in any chat type. */
export function miniAppLink(startParam?: string): string {
  const base = `https://t.me/${env.BOT_USERNAME}/${env.MINI_APP_SHORT_NAME}`;
  return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : base;
}

/** https://t.me/<bot>?start=<param> — opens the bot DM with /start <param>. */
export function botStartLink(param: string): string {
  return `https://t.me/${env.BOT_USERNAME}?start=${encodeURIComponent(param)}`;
}

/**
 * Deep-link payloads shared by bot /start and Mini App start_param.
 * Telegram limits: 64 chars, [A-Za-z0-9_-]. UUIDs (36 chars) fit.
 */
export type StartParam =
  | { kind: "user"; userId: string } // u_<uuid>  open profile
  | { kind: "wishlist"; wishlistId: string } // w_<uuid>  open wishlist
  | { kind: "product"; productId: string } // p_<uuid>  open product / contribute
  | { kind: "session"; sessionId: string } // s_<uuid>  contribute to group session
  | { kind: "premium" }; // premium  open the Mini App upgrade screen

const UUID = /^[0-9a-f-]{36}$/;
export function parseStartParam(raw: string | undefined | null): StartParam | null {
  if (!raw) return null;
  if (raw.trim() === "premium") return { kind: "premium" };
  const [prefix, id] = [raw.slice(0, 2), raw.slice(2)];
  if (!UUID.test(id)) return null;
  switch (prefix) {
    case "u_": return { kind: "user", userId: id };
    case "w_": return { kind: "wishlist", wishlistId: id };
    case "p_": return { kind: "product", productId: id };
    case "s_": return { kind: "session", sessionId: id };
    default: return null;
  }
}
