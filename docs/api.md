# Backend API spec (tRPC)

Source of truth: `src/api/routers/*`. The Mini App imports `type AppRouter` from
`src/api/routers/index.ts` for end-to-end types. Transport: tRPC v11 over HTTP
at `POST|GET /trpc/<router>.<procedure>`, superjson transformer.

## Auth

Every call sends the raw Mini App init data:

```
Authorization: tma <window.Telegram.WebApp.initData>
```

`src/lib/init-data.ts` checks the HMAC (`secret = HMAC_SHA256("WebAppData", BOT_TOKEN)`)
and rejects `auth_date` older than `INIT_DATA_MAX_AGE_SECONDS`. There are no
sessions or JWTs. The user row is created on the first call. The rate limit is
`RATE_LIMIT_PER_MINUTE` per Telegram user, stored in Redis.

Error codes: `UNAUTHORIZED` (bad or expired initData: reload the Mini App),
`NOT_FOUND` (also used for "exists but you may not see it"), `FORBIDDEN`
(`plan_limit:*`, see below), `CONFLICT` (state transition not allowed),
`TOO_MANY_REQUESTS`.

## Visibility rules (`src/services/access.ts`)

| List visibility | Who can read |
|---|---|
| `public` (default) | anyone with the link; group chats |
| `private` | owner + followers the owner **accepted** |
| archived | owner only |

Follow requests wait for approval by default (`users.auto_accept_follows = false`),
because an accepted follower can see private lists.

## Plan limits (`src/lib/entitlements.ts`)

| | free | premium |
|---|---|---|
| public wishlists | 1 | unlimited |
| private wishlists | 1 | unlimited |
| products per wishlist | 5 | unlimited |

Archived items do not count. A breach returns `FORBIDDEN` with message
`plan_limit:public_wishlists` | `plan_limit:private_wishlists` | `plan_limit:products_per_wishlist`.
Downgrading never deletes data.

## Procedures

| Procedure | Type | Input | Notes |
|---|---|---|---|
| **auth.session** | mutation | – | Called on Mini App boot. Refreshes the profile and returns `{ user, startParam, chatType }`. `startParam` is one of `u_<userId>`, `w_<wishlistId>`, `p_<productId>`, `s_<sessionId>`. |
| **users.me** | query | – | `{ user, plan, limits }` (`null` = unlimited) |
| users.updateMe | mutation | `bio?, autoAcceptFollows?, notificationsEnabled?, defaultCurrency?` | Currency = `XTR` or a key in `STARS_RATES`. |
| users.setPlan | mutation | `{plan}` | Stub: always `NOT_IMPLEMENTED` ("Premium coming soon"). |
| users.profile | query | `{userId}` or `{username}` | Profile card, `followStatus` (viewer→user), `followsMe`, counts |
| users.search | query | `{query, limit}` | Prefix search on username or first name |
| **wishlists.list** | query | `{userId?}` | Lists the viewer may see, with item and funded counts |
| wishlists.get | query | `{wishlistId}` | List + products (archived products shown to the owner only) |
| wishlists.create | mutation | `title, description?, emoji?, visibility='public', eventDate?` | Plan limit checked |
| wishlists.update | mutation | `wishlistId` + partial fields | Plan limit checked on a visibility change |
| wishlists.reorder | mutation | `{orderedIds}` | |
| wishlists.archive | mutation | `{wishlistId}` | Soft delete (contribution history is kept). An archived list is read-only: `update`, `products.create` and `products.reorder` return `CONFLICT`. |
| **products.get** | query | `{productId}` | Product, contributor count, pending manual total, active group sessions |
| products.create | mutation | `wishlistId, title, priceMinor, currency, description?, url?, imageUrl?, priority?` | **Manual entry only, no URL scraping in v1.** Plan limit checked. `currency` must be `XTR` or a key in `STARS_RATES`. |
| products.update | mutation | `productId` + partial | Currency is locked after the first confirmed contribution. `funded` status is recomputed when the price changes. |
| products.setStatus | mutation | `{productId, status: purchased\|archived\|active}` | Closing a product also closes its open group sessions |
| products.delete | mutation | `{productId}` | Only if it never had contributions |
| products.reorder | mutation | `{wishlistId, orderedIds}` | |
| products.presignImage | mutation | `{contentType, contentLength}` | Presigned S3/R2 PUT. The client uploads the image, then saves `publicUrl` as `imageUrl`. |
| products.recentlyFundedFeed | query | `{userId?}` | Funded public items from people I follow, or from `userId` (profile screen) |
| **follows.follow** | mutation | `{userId}` | → `pending` (owner gets a DM) or `accepted` (auto-accept is on) |
| follows.unfollow | mutation | `{userId}` | |
| follows.respond | mutation | `{followerId, accept}` | Also available as DM buttons |
| follows.removeFollower | mutation | `{followerId}` | |
| follows.incomingRequests | query | – | |
| follows.followers / following | query | – | Own graph only |
| **contributions.quote** | query | `{productId, stars}` | Amount credited in the product currency, plus Stars needed to finish |
| contributions.createStarsInvoice | mutation | `productId, stars, message?, isAnonymous, groupSessionId?` | Creates a `pending` row and returns `invoiceLink` for `WebApp.openInvoice`. Only the bot's `successful_payment` handler confirms it. |
| contributions.declareManual | mutation | `productId, amountMinor, message?, isAnonymous, groupSessionId?` | The "fake payment" flow. Creates `awaiting_confirmation`; the owner gets a DM with ✅/❌. Max 3 open claims per product per user. |
| contributions.decide | mutation | `{contributionId, decision: confirm\|reject}` | Owner only (`FORBIDDEN` otherwise); a settled row is `CONFLICT` |
| contributions.cancel | mutation | `{contributionId}` | Contributor withdraws a `pending` or `awaiting_confirmation` row; not yours → `NOT_FOUND`, settled → `CONFLICT` |
| contributions.listForProduct | query | `{productId, limit, cursor}` | Confirmed rows; the owner also sees awaiting ones. **Anonymous contributors are masked for everyone except themselves, owner included.** |
| contributions.mine | query | `{limit, cursor}` | |
| contributions.awaitingMyDecision | query | – | Manual claims to decide (anonymous claims stay masked) |
| **groupSessions.get** | query | `{sessionId}` | For a Mini App opened with `s_<id>` |
| groupSessions.leaderboard | query | `{sessionId}` | Top 20; anonymous contributors are grouped as "Anonymous". Unknown id → `NOT_FOUND`; in a `voting` session only the starter and beneficiary may read it |
| groupSessions.forMe | query | – | Sessions raising money for me |

Group sessions are **created and driven by the bot** (see `docs/bot.md`). The API only reads them.

## Money

- All amounts are integers in minor units (`price_minor`, `amount_minor`). `XTR` = Stars, 1 unit = 1 Star.
- Stars → product currency: `floor(stars × STARS_RATES[currency])`. The rate is stored on each contribution for audit.
- Invariant: `products.funded_minor = Σ amount_minor of confirmed contributions`. It is kept in one place
  (`src/services/contributions.ts`) under a row lock, and tested in `contributions.test.ts`.
- Stars land in the **bot owner's** Telegram balance and are tracked against the wish. There is no automatic
  payout to wishlist owners (user decision on MOSA-39: for now the bot owner and the wishlist owner are the same party).

## Health

`GET /healthz` (liveness), `GET /readyz` (checks Postgres + Redis).
