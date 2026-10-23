import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import type { Executor } from "../db/client";
import { contributions, groupSessionVotes, groupSessions, products, users, type GroupSession } from "../db/schema";
import { formatMoney, progressBar } from "../lib/money";
import { miniAppLink } from "../lib/telegram";

export const QUICK_STARS = [50, 100, 250] as const;

/** Callback-data scheme (<= 64 bytes). Parsed in handlers/callbacks.ts. */
export const cb = {
  followAccept: (followerId: string) => `fa:${followerId}`,
  followDecline: (followerId: string) => `fd:${followerId}`,
  manualConfirm: (contributionId: string) => `mc:${contributionId}`,
  manualReject: (contributionId: string) => `mr:${contributionId}`,
  vote: (sessionId: string, n: number) => `gv:${sessionId}:${n}`,
  startSession: (sessionId: string) => `gs:${sessionId}`,
  closeSession: (sessionId: string) => `gx:${sessionId}`,
  quickStars: (sessionId: string, stars: number) => `gp:${sessionId}:${stars}`,
};

export const displayName = (u: { username: string | null; firstName: string }) =>
  u.username ? `@${u.username}` : u.firstName;

export const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Voting message: numbered candidates with live vote counts. */
export async function renderVoting(db: Executor, s: GroupSession) {
  const [beneficiary] = await db.select().from(users).where(eq(users.id, s.beneficiaryId));
  const items = await db.select().from(products).where(inArray(products.id, s.candidateProductIds));
  const votes = await db
    .select({ productId: groupSessionVotes.productId, n: sql<number>`count(*)::int` })
    .from(groupSessionVotes)
    .where(eq(groupSessionVotes.sessionId, s.id))
    .groupBy(groupSessionVotes.productId);
  const byId = new Map(items.map((p) => [p.id, p]));
  const voteCount = new Map(votes.map((v) => [v.productId, v.n]));

  const lines = s.candidateProductIds.map((pid, i) => {
    const p = byId.get(pid);
    if (!p) return `${i + 1}. (removed)`;
    const n = voteCount.get(pid) ?? 0;
    return `${i + 1}. <b>${esc(p.title)}</b> — ${formatMoney(p.priceMinor, p.currency)}${n ? `  ·  ${n} 🗳` : ""}`;
  });
  const kb = new InlineKeyboard();
  s.candidateProductIds.forEach((_, i) => {
    kb.text(String(i + 1), cb.vote(s.id, i + 1));
    if ((i + 1) % 5 === 0) kb.row();
  });
  kb.row().text("▶️ Start with top pick", cb.startSession(s.id)).text("✖️ Cancel", cb.closeSession(s.id));
  return {
    text:
      `🎂 <b>Group gift for ${esc(displayName(beneficiary!))}</b>\n` +
      `Vote for the item to fund together:\n\n${lines.join("\n")}`,
    keyboard: kb,
  };
}

/** Live progress message for an open/completed/closed session. */
export async function renderProgress(db: Executor, s: GroupSession) {
  const [beneficiary] = await db.select().from(users).where(eq(users.id, s.beneficiaryId));
  const [p] = await db.select().from(products).where(eq(products.id, s.productId!));
  const top = await db
    .select({
      name: sql<string>`case when ${contributions.isAnonymous} then 'Anonymous' else coalesce('@' || ${users.username}, ${users.firstName}) end`,
      total: sql<number>`sum(${contributions.amountMinor})::bigint`,
    })
    .from(contributions)
    .innerJoin(users, eq(users.id, contributions.contributorId))
    .where(and(eq(contributions.groupSessionId, s.id), eq(contributions.status, "confirmed")))
    .groupBy(sql`1`)
    .orderBy(desc(sql`2`))
    .limit(5);

  const head =
    s.status === "completed" ? "🎉 <b>Goal reached!</b>"
    : s.status === "closed" ? "🔒 <b>Fundraiser closed</b>"
    : "🎁 <b>Group gift in progress</b>";
  const board = top.length
    ? "\n\n🏆 Top contributors:\n" + top.map((t, i) => `${i + 1}. ${esc(t.name)} — ${formatMoney(Number(t.total), p!.currency)}`).join("\n")
    : "\n\nBe the first to chip in!";
  const text =
    `${head}\nFor ${esc(displayName(beneficiary!))}: <b>${esc(p!.title)}</b>\n\n` +
    `${progressBar(p!.fundedMinor, p!.priceMinor)}\n` +
    `${formatMoney(p!.fundedMinor, p!.currency)} / ${formatMoney(p!.priceMinor, p!.currency)} raised` +
    board;

  const kb = new InlineKeyboard();
  if (s.status === "open") {
    for (const n of QUICK_STARS) kb.text(`⭐ ${n}`, cb.quickStars(s.id, n));
    kb.row().url("🎁 Contribute / other amount", miniAppLink(`s_${s.id}`));
    kb.row().text("🔒 Close", cb.closeSession(s.id));
  }
  return { text, keyboard: kb };
}

export async function renderSession(db: Executor, sessionId: string) {
  const [s] = await db.select().from(groupSessions).where(eq(groupSessions.id, sessionId));
  if (!s) return null;
  if (s.status === "voting") return { session: s, ...(await renderVoting(db, s)) };
  if (!s.productId) return { session: s, text: "✖️ Group gift cancelled.", keyboard: new InlineKeyboard() };
  return { session: s, ...(await renderProgress(db, s)) };
}
