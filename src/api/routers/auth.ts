import { parseStartParam } from "../../lib/telegram";
import { upsertTelegramUser } from "../../services/users";
import { authedProcedure, router } from "../trpc";

export const authRouter = router({
  /**
   * Called once when the Mini App boots. Refreshes the profile from initData
   * and returns the parsed start_param so the client can route
   * (u_ profile, w_ wishlist, p_ product, s_ group session).
   */
  session: authedProcedure.mutation(async ({ ctx }) => {
    // A test context has no initData; there `user` is already the stored row.
    const initData = "initData" in ctx ? ctx.initData : null;
    const user = initData ? await upsertTelegramUser(ctx.db, initData.user) : ctx.user;
    return {
      user,
      startParam: parseStartParam(initData?.startParam),
      // Telegram adds chat_type/chat_instance only when the Mini App was opened
      // from an attachment menu or a `t.me/<bot>/<app>?startapp=...` link in a chat.
      chatType: initData?.chatType ?? null,
    };
  }),
});
