import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import WebApp from "@twa-dev/sdk";
import superjson from "superjson";
import type { AppRouter } from "../../src/api/routers";

export const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({
    url: `${(import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, "")}/trpc`,
    transformer: superjson,
    headers: () => ({ Authorization: `tma ${WebApp.initData}` }),
  })],
});

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15_000 }, mutations: { retry: false } },
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: api, queryClient });

export function message(error: unknown): string {
  const text = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  if (text.includes("plan_limit:")) return "Your current plan limit is reached. Archive an unused item or review Premium.";
  if (/UNAUTHORIZED|initData|auth_date/i.test(text)) return "Your Telegram session expired. Close this app and open it again from the bot.";
  return text;
}

export function money(minor: number, currency: string) {
  return currency === "XTR" ? `${minor.toLocaleString()} Stars` : new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
}
