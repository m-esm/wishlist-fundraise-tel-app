import { router } from "../trpc";
import { authRouter } from "./auth";
import { contributionsRouter } from "./contributions";
import { followsRouter } from "./follows";
import { groupSessionsRouter } from "./group-sessions";
import { productsRouter } from "./products";
import { subscriptionsRouter } from "./subscriptions";
import { usersRouter } from "./users";
import { wishlistsRouter } from "./wishlists";

export const appRouter = router({
  auth: authRouter,
  users: usersRouter,
  subscriptions: subscriptionsRouter,
  wishlists: wishlistsRouter,
  products: productsRouter,
  follows: followsRouter,
  contributions: contributionsRouter,
  groupSessions: groupSessionsRouter,
});

/** Imported (type-only) by the Mini App for end-to-end types. */
export type AppRouter = typeof appRouter;
