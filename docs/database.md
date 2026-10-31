# Database schema

Source: `src/db/schema.ts` (Drizzle ORM). Migrations: `src/db/migrations/` (generated
with `npm run db:generate`, applied with `bun src/db/migrate.ts` as a one-shot
job before api/bot roll out). Target: PostgreSQL 16 on CNPG.

## Tables

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Telegram identity + settings | `telegram_id` unique; `lower(username)` unique; `auto_accept_follows` default **false**; `can_dm` (user started the bot) |
| `subscriptions` | Current Premium plan (no row = free) | `user_id` unique; `expires_at` null = lifetime; `trial_expires_at` is the one-time trial and is not a charge id |
| `wishlists` | A user's lists | `visibility` ∈ {`public`, `private`}, default `public`; soft delete via `archived_at` |
| `products` | Wish items (manual entry) | `price_minor > 0`; `funded_minor ≥ 0`; `status` ∈ {active, funded, purchased, archived}; `currency` = ISO-4217 or `XTR` |
| `follows` | Social graph | PK (`follower_id`, `followee_id`); no self-follow; `status` ∈ {pending, accepted, rejected} |
| `contributions` | Stars or manual money toward a product | unique `telegram_payment_charge_id` (idempotency); `amount_minor > 0`; `stars_amount` set ⇔ `method = stars`; `contributor_id` is always kept, even when `is_anonymous` |
| `telegram_chats` | Groups the bot is in | PK `chat_id` (bigint) |
| `group_sessions` | Group fundraise in a chat | **partial unique** (`telegram_chat_id`) where status ∈ {voting, open}; `product_id` required unless voting/cancelled; `candidate_product_ids uuid[]` = button order |
| `group_session_votes` | One vote per member per session | PK (`session_id`, `user_id`) |
| `notification_outbox` | Transactional outbox for DMs and group edits | partial index on due pending rows; partial unique `dedupe_key` among pending rows |
| `subscription_payments` | One Telegram Stars charge for Premium | `telegram_payment_charge_id` unique and not null; `stars_amount > 0`; `term` ∈ {`annual`, `lifetime`}; `refunded_at` set when that charge is refunded |

## State machines

```
contributions (stars):   pending ──successful_payment──▶ confirmed ──refunded_payment──▶ refunded
                            └──cancel──▶ cancelled   (a late payment is still credited)
contributions (manual):  awaiting_confirmation ──owner ✅──▶ confirmed
                                               ├─owner ❌──▶ rejected
                                               └─cancel──▶ cancelled
products:                active ──funded_minor ≥ price──▶ funded ──owner──▶ purchased
                         any ──owner──▶ archived (stops collecting; history kept)
group_sessions:          voting ──▶ open ──goal reached──▶ completed
                         voting ──▶ cancelled        open ──/close──▶ closed
follows:                 pending ──▶ accepted | rejected
```

## Design notes

- **Money** is stored as integer minor units, never floats. `funded_minor` is denormalised for cheap
  progress bars, and every change to it goes through `src/services/contributions.ts` in one transaction
  with a `FOR UPDATE` lock on the contribution and the product.
- **Telegram ids** are `bigint` (they exceed int32).
- **Deletes**: `contributions.product_id` and `contributor_id` are `ON DELETE RESTRICT`, so money history
  cannot vanish. Lists and products are archived instead of deleted.
- **Anonymity**: `is_anonymous` hides the contributor in every API response and bot message (the owner
  included), but `contributor_id` is always stored for audit/refunds.
- **Scale**: the expected load is tens of users. One API replica and one bot replica are enough. The outbox uses
  `SKIP LOCKED`, so more bot replicas would be safe later.
- **Premium charges** are one `subscription_payments` row per Telegram charge. `subscriptions` stores only the
  current plan: the trial end, the annual expiry, or lifetime (`expires_at` null). A refund marks that charge
  and replays the charges that are still paid, including a charge that is not the latest. A payment update
  looks the user up by `telegram_id` and does not write `username`.
