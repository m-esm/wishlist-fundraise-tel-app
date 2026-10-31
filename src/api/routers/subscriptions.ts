import { TRPCError } from "@trpc/server";
import {
  SubscriptionError,
  createPremiumInvoice,
  initiateTrial,
  subscriptionStatus,
} from "../../services/subscriptions";
import { authedProcedure, router } from "../trpc";

function rethrow(error: unknown): never {
  if (error instanceof SubscriptionError) {
    throw new TRPCError({ code: error.trpcCode, message: error.message });
  }
  throw error;
}

export const subscriptionsRouter = router({
  /** Current plan, expiry, trial availability, and the Stars price of €12.50. */
  getStatus: authedProcedure.query(({ ctx }) => subscriptionStatus(ctx.db, ctx.user.id)),

  /** First activation only. Sets expiry to now + 30 days and does not send an invoice. */
  initiateTrial: authedProcedure.mutation(async ({ ctx }) => {
    try {
      return await initiateTrial(ctx.db, ctx.user.id);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** Stars invoice for one year. Expiry is applied when Telegram confirms payment. */
  purchaseAnnual: authedProcedure.mutation(async ({ ctx }) => {
    try {
      return await createPremiumInvoice(ctx.db, ctx.user, "annual");
    } catch (error) {
      rethrow(error);
    }
  }),

  /** Stars invoice for lifetime Premium (`expiresAt` stays null after confirmation). */
  purchaseLifetime: authedProcedure.mutation(async ({ ctx }) => {
    try {
      return await createPremiumInvoice(ctx.db, ctx.user, "lifetime");
    } catch (error) {
      rethrow(error);
    }
  }),
});
