import type { DB } from "../db/client";
import type { Product, User, Wishlist } from "../db/schema";
import { contributions, follows, products, subscriptions, users, wishlists } from "../db/schema";
import { testDb } from "./pglite";
import { makeCaller, type TestCaller } from "./net";

/** Shared fixtures for the per-router tests. */
export interface Fixture {
  db: DB;
  owner: User;
  /** A second user; by default an accepted follower of `owner`. */
  friend: User;
  stranger: User;
  wishlist: Wishlist;
  product: Product;
  ownerCaller: TestCaller;
  friendCaller: TestCaller;
  strangerCaller: TestCaller;
}

let nextTelegramId = 1000;

export async function user(
  db: DB,
  fields: Partial<typeof users.$inferInsert> & { firstName: string } = { firstName: "User" },
): Promise<User> {
  const id = nextTelegramId++;
  const [row] = await db
    .insert(users)
    .values({
      telegramId: id,
      username: `user${id}`,
      ...fields,
    })
    .returning();
  return row!;
}

/** Base world: owner has one public list with one USD product; friend follows owner (accepted). */
export async function fixture(): Promise<Fixture> {
  const db = await testDb();
  const owner = await user(db, { firstName: "Owner", username: "owner" });
  const friend = await user(db, { firstName: "Friend", username: "friend" });
  const stranger = await user(db, { firstName: "Stranger", username: "stranger" });
  const [wishlist] = await db.insert(wishlists).values({ ownerId: owner.id, title: "Birthday" }).returning();
  const [product] = await db
    .insert(products)
    .values({ wishlistId: wishlist!.id, title: "Headphones", priceMinor: 1000, currency: "USD" })
    .returning();
  await db.insert(follows).values({
    followerId: friend.id,
    followeeId: owner.id,
    status: "accepted",
    respondedAt: new Date(),
  });
  return {
    db,
    owner,
    friend,
    stranger,
    wishlist: wishlist!,
    product: product!,
    ownerCaller: await makeCaller(db, owner),
    friendCaller: await makeCaller(db, friend),
    strangerCaller: await makeCaller(db, stranger),
  };
}

export async function setPremium(db: DB, userId: string, expiresAt: Date | null = null) {
  await db.insert(subscriptions).values({ userId, plan: "premium", expiresAt });
}

export async function newWishlist(
  db: DB,
  ownerId: string,
  visibility: "public" | "private" = "public",
  title = "List",
) {
  const [w] = await db.insert(wishlists).values({ ownerId, title, visibility }).returning();
  return w!;
}

export async function newProduct(
  db: DB,
  wishlistId: string,
  title = "Item",
  priceMinor = 500,
  currency = "USD",
) {
  const [p] = await db
    .insert(products)
    .values({ wishlistId, title, priceMinor, currency })
    .returning();
  return p!;
}

/** Inserts a contribution row directly (services own the money transitions). */
export async function contribution(
  db: DB,
  fields: Partial<typeof contributions.$inferInsert> & { productId: string; contributorId: string },
) {
  const method = fields.method ?? "manual";
  const [c] = await db
    .insert(contributions)
    .values({
      status: "confirmed",
      amountMinor: 100,
      currency: "USD",
      isAnonymous: false,
      ...(method === "stars" ? { starsAmount: fields.starsAmount ?? 10, starsRate: 1 } : {}),
      ...fields,
      method,
    })
    .returning();
  return c!;
}
