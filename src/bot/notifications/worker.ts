import { and, eq, sql } from "drizzle-orm";
import { GrammyError, InlineKeyboard, type Api } from "grammy";
import { db } from "../../db/client";
import { contributions, groupSessions, notificationOutbox, products, users } from "../../db/schema";
import { env } from "../../env";
import { formatMoney } from "../../lib/money";
import { miniAppLink } from "../../lib/telegram";
import { manualClaimMessage } from "../commands/private";
import { cb, displayName, esc, renderSession } from "../render";

type Row = typeof notificationOutbox.$inferSelect;
type Send = { text: string; keyboard?: InlineKeyboard } | null;

/**
 * Delivers notification_outbox rows. At-least-once:
 *   claim  -> lease the row for 60 s (attempts+1) with SKIP LOCKED, so several
 *             bot replicas can run the worker safely
 *   send   -> Telegram call outside any transaction
 *   settle -> sent | retry with backoff | failed
 * A claimed group_progress row drops its dedupe_key so new payments can enqueue
 * a fresh edit while this one is in flight.
 */
async function claim(): Promise<Row[]> {
  const rows = await db.execute<Row>(sql`
    update notification_outbox set
      next_attempt_at = now() + interval '60 seconds',
      attempts = attempts + 1,
      dedupe_key = null
    where id in (
      select id from notification_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by id limit ${env.OUTBOX_BATCH_SIZE}
      for update skip locked)
    returning id, kind, user_id as "userId", chat_id as "chatId", payload, attempts`);
  return (Array.isArray(rows) ? rows : (rows as unknown as { rows: Row[] }).rows) as Row[];
}

async function settle(id: number, outcome: { ok: true } | { ok: false; error: string; retryInSec?: number; final?: boolean }, attempts: number) {
  if (outcome.ok) {
    await db.update(notificationOutbox).set({ status: "sent", sentAt: new Date() }).where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.status, "pending"), eq(notificationOutbox.attempts, attempts)));
    return;
  }
  const final = outcome.final || attempts >= env.OUTBOX_MAX_ATTEMPTS;
  const backoff = outcome.retryInSec ?? Math.min(3600, 2 ** attempts * 5);
  await db
    .update(notificationOutbox)
    .set({
      status: final ? "failed" : "pending",
      lastError: outcome.error.slice(0, 500),
      nextAttemptAt: sql`now() + make_interval(secs => ${backoff})`,
    })
    .where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.status, "pending"), eq(notificationOutbox.attempts, attempts)));
}

async function contributionInfo(contributionId: string) {
  const [r] = await db
    .select({ c: contributions, product: products, who: users })
    .from(contributions)
    .innerJoin(products, eq(products.id, contributions.productId))
    .innerJoin(users, eq(users.id, contributions.contributorId))
    .where(eq(contributions.id, contributionId));
  return r;
}

async function userName(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u ? displayName(u) : "Someone";
}

/** Renders a DM. Returns null to skip silently (e.g. entity deleted). */
async function renderDm(row: Row): Promise<Send | { raw: ReturnType<typeof manualClaimMessage> }> {
  const p = row.payload as Record<string, string>;
  switch (row.kind) {
    case "follow_request": {
      const name = await userName(p.followerId!);
      return {
        text: `👋 ${esc(name)} wants to follow you.`,
        keyboard: new InlineKeyboard().text("✅ Accept", cb.followAccept(p.followerId!)).text("❌ Decline", cb.followDecline(p.followerId!)),
      };
    }
    case "follow_accepted": {
      const name = await userName(p.followeeId!);
      return {
        text: `✅ ${esc(name)} accepted your follow request.`,
        keyboard: new InlineKeyboard().url("See their wishlists", miniAppLink(`u_${p.followeeId}`)),
      };
    }
    case "contribution_received": {
      const r = await contributionInfo(p.contributionId!);
      if (!r) return null;
      const who = r.c.isAnonymous ? "Someone" : displayName(r.who);
      return {
        text: `🎁 ${esc(who)} chipped in <b>${formatMoney(r.c.amountMinor, r.c.currency)}</b> for <b>${esc(r.product.title)}</b>` +
          (r.c.message ? `\n“${esc(r.c.message)}”` : ""),
        keyboard: new InlineKeyboard().url("View progress", miniAppLink(`p_${r.product.id}`)),
      };
    }
    case "manual_claim": {
      const r = await contributionInfo(p.contributionId!);
      if (!r || r.c.status !== "awaiting_confirmation") return null;
      const who = r.c.isAnonymous ? "Someone (anonymous)" : displayName(r.who);
      return { raw: manualClaimMessage(r.c.id, who, r.product.title, formatMoney(r.c.amountMinor, r.c.currency), r.c.message) };
    }
    case "manual_decided": {
      const r = await contributionInfo(p.contributionId!);
      if (!r) return null;
      const ok = r.c.status === "confirmed";
      return {
        text: ok
          ? `✅ Your ${formatMoney(r.c.amountMinor, r.c.currency)} for <b>${esc(r.product.title)}</b> was confirmed. Thank you!`
          : `❌ Your claimed payment for <b>${esc(r.product.title)}</b> was marked as not received. Contact the owner if this is a mistake.`,
      };
    }
    case "product_funded": {
      const [prod] = await db.select().from(products).where(eq(products.id, p.productId!));
      if (!prod) return null;
      return {
        text: `🎉 <b>${esc(prod.title)}</b> is fully funded: ${formatMoney(prod.fundedMinor, prod.currency)}!`,
        keyboard: new InlineKeyboard().url("See who chipped in", miniAppLink(`p_${prod.id}`)),
      };
    }
    default:
      throw new Error(`unknown outbox kind ${row.kind}`);
  }
}

async function deliver(api: Api, row: Row): Promise<void> {
  if (row.kind === "group_progress") {
    const sessionId = (row.payload as { sessionId: string }).sessionId;
    const r = await renderSession(db, sessionId);
    if (!r?.session.progressMessageId) return;
    await api
      .editMessageText(row.chatId!, r.session.progressMessageId, r.text, { parse_mode: "HTML", reply_markup: r.keyboard })
      .catch((e) => {
        if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
        throw e;
      });
    return;
  }

  const [u] = await db.select().from(users).where(eq(users.id, row.userId!));
  if (!u || !u.canDm || !u.notificationsEnabled) return; // in-app state is the source of truth
  const msg = await renderDm(row);
  if (!msg) return;
  if ("raw" in msg) {
    const [text, opts] = msg.raw;
    await api.sendMessage(u.telegramId, text, opts);
  } else {
    await api.sendMessage(u.telegramId, msg.text, { parse_mode: "HTML", reply_markup: msg.keyboard });
  }
}

/** One bounded pass, also used by offline smoke tests. */
export async function processOutboxBatch(api: Api): Promise<number> {
  const rows = await claim();
  for (const row of rows) {
    try {
      await deliver(api, row);
      await settle(row.id, { ok: true }, row.attempts);
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 403) {
        if (row.userId) await db.update(users).set({ canDm: false }).where(eq(users.id, row.userId));
        if (row.chatId) await db.update(groupSessions).set({ progressMessageId: null }).where(eq(groupSessions.telegramChatId, row.chatId));
        await settle(row.id, { ok: false, error: e.description, final: true }, row.attempts);
      } else if (e instanceof GrammyError && e.error_code === 429) {
        await settle(row.id, { ok: false, error: e.description, retryInSec: e.parameters.retry_after ?? 5 }, row.attempts);
      } else {
        await settle(row.id, { ok: false, error: String(e) }, row.attempts);
      }
    }
  }
  return rows.length;
}

export function startOutboxWorker(api: Api): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      let count = 0;
      try {
        count = await processOutboxBatch(api);
      } catch (e) {
        console.error("outbox loop error", e);
      }
      if (count < env.OUTBOX_BATCH_SIZE) await Bun.sleep(env.OUTBOX_POLL_INTERVAL_MS);
    }
  };
  void loop();
  return () => { stopped = true; };
}
