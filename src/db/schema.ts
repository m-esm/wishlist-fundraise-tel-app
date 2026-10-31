import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Money convention: every amount is an integer in the *minor unit* of its
 * currency (cents for USD, 1 Star for XTR). Never store floats for money.
 * Telegram ids (users, chats) exceed 2^31, so they are bigint (mode: number is
 * safe: Telegram guarantees ids fit in 52 bits).
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------- enums

/**
 * public  -> anyone with the link, and group chats
 * private -> the owner and followers the owner accepted
 */
export const wishlistVisibility = pgEnum("wishlist_visibility", ["public", "private"]);
export const followStatus = pgEnum("follow_status", ["pending", "accepted", "rejected"]);
export const productStatus = pgEnum("product_status", ["active", "funded", "purchased", "archived"]);
export const subscriptionPlan = pgEnum("subscription_plan", ["free", "premium"]);
export const subscriptionTerm = pgEnum("subscription_term", ["annual", "lifetime"]);
/** "manual" = the plan's "fake payment": contributor declares, owner confirms. */
export const contributionMethod = pgEnum("contribution_method", ["stars", "manual"]);
export const contributionStatus = pgEnum("contribution_status", [
  "pending", // stars: invoice created, not yet paid
  "awaiting_confirmation", // manual: declared, owner has not decided
  "confirmed", // counts toward products.funded_minor
  "rejected", // manual: owner rejected
  "cancelled", // contributor withdrew / invoice expired
  "refunded", // stars: refunded via refundStarPayment
]);
export const groupSessionStatus = pgEnum("group_session_status", [
  "voting", // members pick an item
  "open", // collecting contributions for product_id
  "completed", // product reached goal
  "closed", // closed manually before goal
  "cancelled", // cancelled during voting
]);
export const botChatStatus = pgEnum("bot_chat_status", ["member", "administrator", "left", "kicked"]);
export const outboxStatus = pgEnum("outbox_status", ["pending", "sent", "failed"]);

// ---------------------------------------------------------------- users

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
    username: text("username"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    languageCode: text("language_code"),
    photoUrl: text("photo_url"),
    bio: text("bio"),
    /**
     * Off (default): every follow request waits for approval, because an
     * accepted follower can see private lists. On: requests auto-accept.
     */
    autoAcceptFollows: boolean("auto_accept_follows").notNull().default(false),
    /** True once the user has /start-ed the bot in DM and not blocked it. */
    canDm: boolean("can_dm").notNull().default(false),
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    defaultCurrency: char("default_currency", { length: 3 }).notNull().default("USD"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_telegram_id_uq").on(t.telegramId),
    uniqueIndex("users_username_lower_uq").on(sql`lower(${t.username})`),
  ],
);

// ---------------------------------------------------------------- wishlists

export const wishlists = pgTable(
  "wishlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    emoji: text("emoji"),
    visibility: wishlistVisibility("visibility").notNull().default("public"),
    eventDate: timestamp("event_date", { withTimezone: true }),
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("wishlists_owner_idx").on(t.ownerId, t.position),
    check("wishlists_title_len", sql`char_length(${t.title}) between 1 and 120`),
  ],
);

// ---------------------------------------------------------------- products

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wishlistId: uuid("wishlist_id")
      .notNull()
      .references(() => wishlists.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    url: text("url"),
    imageUrl: text("image_url"),
    /** Goal amount, minor units of `currency`. */
    priceMinor: bigint("price_minor", { mode: "number" }).notNull(),
    /** ISO-4217 code, or "XTR" for a goal expressed directly in Stars. */
    currency: char("currency", { length: 3 }).notNull(),
    /** Denormalised sum of confirmed contributions; updated in the same tx. */
    fundedMinor: bigint("funded_minor", { mode: "number" }).notNull().default(0),
    status: productStatus("status").notNull().default("active"),
    priority: integer("priority").notNull().default(0),
    position: integer("position").notNull().default(0),
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("products_wishlist_idx").on(t.wishlistId, t.position),
    check("products_price_positive", sql`${t.priceMinor} > 0`),
    check("products_funded_nonneg", sql`${t.fundedMinor} >= 0`),
    check("products_title_len", sql`char_length(${t.title}) between 1 and 200`),
  ],
);

// ---------------------------------------------------------------- follows

export const follows = pgTable(
  "follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeId: uuid("followee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: followStatus("status").notNull().default("pending"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    index("follows_followee_status_idx").on(t.followeeId, t.status),
    check("follows_no_self", sql`${t.followerId} <> ${t.followeeId}`),
  ],
);

// ---------------------------------------------------------------- telegram chats (groups the bot is in)

export const telegramChats = pgTable("telegram_chats", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  type: text("type").notNull(), // group | supergroup | channel
  title: text("title"),
  botStatus: botChatStatus("bot_status").notNull(),
  addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});

// ---------------------------------------------------------------- group fundraise sessions

export const groupSessions = pgTable(
  "group_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" })
      .notNull()
      .references(() => telegramChats.chatId, { onDelete: "cascade" }),
    beneficiaryId: uuid("beneficiary_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Items offered for the vote, in button order (button n -> candidateProductIds[n-1]). */
    candidateProductIds: uuid("candidate_product_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** Null while status = voting. */
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: groupSessionStatus("status").notNull().default("voting"),
    /** The bot message that is edited with live progress. */
    progressMessageId: integer("progress_message_id"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // At most one active (voting|open) session per group chat.
    uniqueIndex("group_sessions_one_active_per_chat_uq")
      .on(t.telegramChatId)
      .where(sql`${t.status} in ('voting', 'open')`),
    index("group_sessions_product_idx").on(t.productId),
    check("group_sessions_open_has_product", sql`${t.status} = 'voting' or ${t.status} = 'cancelled' or ${t.productId} is not null`),
  ],
);

export const groupSessionVotes = pgTable(
  "group_session_votes",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => groupSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

// ---------------------------------------------------------------- contributions

export const contributions = pgTable(
  "contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    contributorId: uuid("contributor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    groupSessionId: uuid("group_session_id").references(() => groupSessions.id, { onDelete: "set null" }),
    method: contributionMethod("method").notNull(),
    status: contributionStatus("status").notNull(),
    /** Amount credited to the product, in the product's currency minor units. */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    /** Stars actually charged (method = stars only). */
    starsAmount: integer("stars_amount"),
    /** Minor units of `currency` per Star used for conversion (audit). */
    starsRate: real("stars_rate"),
    message: text("message"),
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    telegramPaymentChargeId: text("telegram_payment_charge_id"),
    providerPaymentChargeId: text("provider_payment_charge_id"),
    decidedById: uuid("decided_by_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Idempotency for successful_payment redelivery.
    uniqueIndex("contributions_tg_charge_uq").on(t.telegramPaymentChargeId),
    index("contributions_product_status_idx").on(t.productId, t.status),
    index("contributions_contributor_idx").on(t.contributorId, t.createdAt),
    index("contributions_session_idx").on(t.groupSessionId),
    check("contributions_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "contributions_stars_fields",
      sql`(${t.method} = 'stars') = (${t.starsAmount} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------- notification outbox

/**
 * Transactional outbox. API and bot write rows inside the same transaction as
 * the state change; the bot worker delivers them (DMs, group message edits)
 * with retries and Telegram rate-limit handling.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    /** Recipient user (DM). Null for group-targeted kinds. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Recipient chat for group-targeted kinds. */
    chatId: bigint("chat_id", { mode: "number" }),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    /** Collapses duplicates, e.g. one pending group_progress edit per session. */
    dedupeKey: text("dedupe_key"),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbox_due_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    uniqueIndex("outbox_pending_dedupe_uq").on(t.dedupeKey).where(sql`${t.status} = 'pending'`),
    check("outbox_has_target", sql`${t.userId} is not null or ${t.chatId} is not null`),
  ],
);

// ---------------------------------------------------------------- subscriptions

/**
 * Current Premium plan for one user. No row = free, and a trial is still
 * available. A row with `expires_at` null is lifetime. This row does not store
 * a charge id: each Stars charge is a `subscription_payments` row.
 * Limits and the €12.50 price live in src/lib/entitlements.ts.
 */
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  plan: subscriptionPlan("plan").notNull().default("free"),
  /** Null = active indefinitely (lifetime). A past timestamp means Premium has ended. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** End of the one-time trial. Payments do not overwrite this. Null = no trial. */
  trialExpiresAt: timestamp("trial_expires_at", { withTimezone: true }),
  ...timestamps,
});

/**
 * One row per Telegram Stars charge for Premium. Unique on the charge id so a
 * redelivery cannot insert a second row, and a refund can find an older charge.
 */
export const subscriptionPayments = pgTable(
  "subscription_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    term: subscriptionTerm("term").notNull(),
    starsAmount: integer("stars_amount").notNull(),
    telegramPaymentChargeId: text("telegram_payment_charge_id").notNull(),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("subscription_payments_tg_charge_uq").on(t.telegramPaymentChargeId),
    index("subscription_payments_user_idx").on(t.userId, t.createdAt),
    check("subscription_payments_stars_positive", sql`${t.starsAmount} > 0`),
  ],
);

// ---------------------------------------------------------------- relations

export const usersRelations = relations(users, ({ one, many }) => ({
  wishlists: many(wishlists),
  contributions: many(contributions),
  subscription: one(subscriptions, { fields: [users.id], references: [subscriptions.userId] }),
  subscriptionPayments: many(subscriptionPayments),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
}));

export const subscriptionPaymentsRelations = relations(subscriptionPayments, ({ one }) => ({
  user: one(users, { fields: [subscriptionPayments.userId], references: [users.id] }),
}));

export const wishlistsRelations = relations(wishlists, ({ one, many }) => ({
  owner: one(users, { fields: [wishlists.ownerId], references: [users.id] }),
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  wishlist: one(wishlists, { fields: [products.wishlistId], references: [wishlists.id] }),
  contributions: many(contributions),
}));

export const contributionsRelations = relations(contributions, ({ one }) => ({
  product: one(products, { fields: [contributions.productId], references: [products.id] }),
  contributor: one(users, { fields: [contributions.contributorId], references: [users.id] }),
  groupSession: one(groupSessions, {
    fields: [contributions.groupSessionId],
    references: [groupSessions.id],
  }),
}));

export const groupSessionsRelations = relations(groupSessions, ({ one, many }) => ({
  chat: one(telegramChats, { fields: [groupSessions.telegramChatId], references: [telegramChats.chatId] }),
  beneficiary: one(users, { fields: [groupSessions.beneficiaryId], references: [users.id] }),
  product: one(products, { fields: [groupSessions.productId], references: [products.id] }),
  votes: many(groupSessionVotes),
  contributions: many(contributions),
}));

export const groupSessionVotesRelations = relations(groupSessionVotes, ({ one }) => ({
  session: one(groupSessions, { fields: [groupSessionVotes.sessionId], references: [groupSessions.id] }),
}));

export type User = typeof users.$inferSelect;
export type Wishlist = typeof wishlists.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Contribution = typeof contributions.$inferSelect;
export type GroupSession = typeof groupSessions.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionPayment = typeof subscriptionPayments.$inferSelect;
