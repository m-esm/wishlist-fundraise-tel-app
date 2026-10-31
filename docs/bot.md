# Telegram bot: command map and update handlers

Source: `src/bot/`. The bot uses grammY with a webhook in production
(`BOT_MODE=webhook`, `POST /telegram/webhook`, secret-token header checked) and
long polling for local development.

`allowed_updates`: `message`, `callback_query`, `inline_query`, `pre_checkout_query`, `my_chat_member`.

BotFather setup: register the Mini App (short name = `MINI_APP_SHORT_NAME`) and
turn on inline mode. Group privacy mode can stay **on**, because the bot only
needs the commands addressed to it.

## Private chat (DM)

| Command | What it does |
|---|---|
| `/start [param]` | Welcome + "Open" button. `param` = `u_<userId>` / `w_<wishlistId>` / `p_<productId>` / `s_<sessionId>` opens the Mini App at that screen. `premium` opens the upgrade screen. There is no `/premium` command. Any DM sets `users.can_dm = true`. |
| `/app` | Button that opens the Mini App |
| `/mylists` | My lists with funded/total counts; each button opens the list |
| `/requests` | Pending follow requests with ✅ Accept / ❌ Decline |
| `/pending` | Manual payment claims to confirm (✅ Received / ❌ Not received) |
| `/settings [on\|off]` | DM notifications on/off |
| `/paysupport` | **Required by Telegram for Stars payments.** Sends the user's request to `SUPPORT_CHAT_ID` |
| `/terms` | Short terms |
| `/help` | Command list |

## Group / supergroup

| Command | What it does | Who |
|---|---|---|
| `/fundraise @user` | Lists up to 10 **public** active items of @user with vote buttons `1…n`, plus ▶️ Start / ✖️ Cancel | anyone |
| `/fundraise @user <n>` | Skips the vote and starts collecting for item n | anyone |
| `/status` | Posts the live vote or progress message again | anyone |
| `/contribute <stars>` | Sends a Stars invoice for the open session | anyone |
| `/close` (`/cancel`) | Closes the session (voting → `cancelled`, open → `closed`). Confirmed money stays credited. | starter or chat admin |
| `/help` | Group help | anyone |

There can be one active session (`voting` or `open`) per chat; a partial unique
index enforces this. @user must have opened the bot or Mini App once, so that
the username resolves.

### Progress message (edited live)

```
🎁 Group gift in progress
For @ann: Sony WH-1000XM5

▓▓▓▓▓▓░░░░ 60%
$120.00 / $200.00 raised

🏆 Top contributors:
1. @bob — $50.00
2. Anonymous — $40.00
[⭐ 50] [⭐ 100] [⭐ 250]
[🎁 Contribute / other amount]   → t.me/<bot>/<app>?startapp=s_<sessionId>
[🔒 Close]
```

The outbox edits this message after every confirmed contribution (one pending
edit per session, bursts are merged with a 2 s delay). When the goal is reached,
the session becomes `completed` and the buttons go away.

## Callback data (≤ 64 bytes)

| Prefix | Meaning |
|---|---|
| `fa:<followerId>` / `fd:<followerId>` | accept / decline a follow request |
| `mc:<contributionId>` / `mr:<contributionId>` | confirm / reject a manual payment (owner only) |
| `gv:<sessionId>:<n>` | vote for candidate n (one vote per user; the beneficiary cannot vote) |
| `gs:<sessionId>` | start collecting for the top-voted item (a tie goes to the first listed) |
| `gx:<sessionId>` | close or cancel the session |
| `gp:<sessionId>:<stars>` | quick Stars contribution. The invoice goes to the user's DM if `can_dm`, otherwise to the group. |

Unknown or stale callbacks are answered with "This button has expired."

## Inline mode

`@<bot> [filter]` in any chat: shares "my profile" or one of my lists (🔒 marks a
private list) as a card with an Open button. Visibility is checked again when the
link is opened.

## Update handlers

| Update | Handler | Effect |
|---|---|---|
| `pre_checkout_query` | `handlers/payments.ts` | Checks the payload (`c:<contributionId>` or `s:<sessionId>`), currency `XTR`, amount, and that the product is still `active`. Must answer within 10 s. |
| `message.successful_payment` | `handlers/payments.ts` | `recordStarsPayment`: idempotent on `telegram_payment_charge_id`, credits the product, queues notifications. On error the webhook returns non-200, so Telegram redelivers. |
| `message.refunded_payment` | `handlers/payments.ts` | `recordStarsRefund`: reverses the credit; `funded` → `active` if the total drops below the goal |
| `my_chat_member` (private) | `handlers/membership.ts` | user blocked or unblocked the bot → `users.can_dm` |
| `my_chat_member` (group) | `handlers/membership.ts` | bot added or removed → `telegram_chats`, greeting message |
| `message.migrate_to_chat_id` | `handlers/membership.ts` | group → supergroup: moves sessions to the new chat id |
| `inline_query` | `handlers/inline.ts` | share cards |

## Notifications (transactional outbox)

State changes write `notification_outbox` rows in the same DB transaction. The
bot worker (`notifications/worker.ts`) claims them with `FOR UPDATE SKIP LOCKED`
and a 60 s lease, sends them, and retries with backoff. A 429 response honours
`retry_after`; a 403 marks the user `can_dm = false` and drops the row.

| kind | To | Message |
|---|---|---|
| `follow_request` | followee | "👋 X wants to follow you" + Accept/Decline |
| `follow_accepted` | follower | "✅ X accepted" + open profile |
| `contribution_received` | owner | "🎁 X chipped in $Y for Z" ("Someone" if anonymous) |
| `manual_claim` | owner | "💸 X says they sent you $Y" + Received/Not received ("Someone (anonymous)" if anonymous) |
| `manual_decided` | contributor | confirmed / not received |
| `product_funded` | owner | "🎉 Z is fully funded" |
| `group_progress` | group chat | edits the session progress message |

DMs are skipped when the user has not started the bot (`can_dm = false`) or turned
notifications off. The Mini App state is the source of truth either way.
