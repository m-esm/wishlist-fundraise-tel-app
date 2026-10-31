import { eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { users, type User } from "../db/schema";

export interface TelegramUserLike {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

/**
 * Upserts a user from any Telegram identity source (initData, bot update).
 * Usernames are unique case-insensitively; if someone else held this username
 * (renames happen), the stale holder is cleared first.
 */
export async function upsertTelegramUser(db: Executor, tu: TelegramUserLike): Promise<User> {
  if (tu.username) {
    await db
      .update(users)
      .set({ username: null })
      .where(sql`lower(${users.username}) = lower(${tu.username}) and ${users.telegramId} <> ${tu.id}`);
  }
  const values = {
    telegramId: tu.id,
    firstName: tu.first_name,
    lastName: tu.last_name ?? null,
    username: tu.username ?? null,
    languageCode: tu.language_code ?? null,
    ...(tu.photo_url ? { photoUrl: tu.photo_url } : {}),
    lastSeenAt: new Date(),
  };
  const [row] = await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({ target: users.telegramId, set: values })
    .returning();
  return row!;
}

/** Read a Telegram user. Does not insert a row and does not change username. */
export async function findTelegramUser(db: Executor, telegramId: number): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.telegramId, telegramId));
  return row;
}

/**
 * Insert a payer this app has never stored. An existing row is returned as it
 * is, so a payment that omits username cannot write `username` null.
 */
export async function insertTelegramUserIfAbsent(db: Executor, tu: TelegramUserLike): Promise<User> {
  const existing = await findTelegramUser(db, tu.id);
  if (existing) return existing;
  if (tu.username) {
    await db
      .update(users)
      .set({ username: null })
      .where(sql`lower(${users.username}) = lower(${tu.username}) and ${users.telegramId} <> ${tu.id}`);
  }
  const [created] = await db
    .insert(users)
    .values({
      telegramId: tu.id,
      firstName: tu.first_name,
      lastName: tu.last_name ?? null,
      username: tu.username ?? null,
      languageCode: tu.language_code ?? null,
      ...(tu.photo_url ? { photoUrl: tu.photo_url } : {}),
    })
    .onConflictDoNothing({ target: users.telegramId })
    .returning();
  if (created) return created;
  return (await findTelegramUser(db, tu.id))!;
}
