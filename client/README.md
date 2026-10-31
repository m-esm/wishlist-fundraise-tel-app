# Telegram Mini App

Type checking reads the server router types, so install the backend types first. From the repository root:

```sh
npm ci --include=dev
```

Then run:

```sh
cd client
npm ci --include=dev
npm run typecheck
npm run build
node scripts/check-boundary.mjs
VITE_API_URL=http://localhost:8080 npm run dev
```

Use `--include=dev` when `NODE_ENV=production`. It installs the TypeScript and Vite packages. Without it, `npm ci` installs the runtime packages only and the build stops at the `vite/client` types.

`node scripts/check-boundary.mjs` builds each probe import against the real files under the repository-root `src/`. A probe passes only when the build fails with the gate's own diagnostic, so an unrelated build error cannot hide a leak. A control proves that `@trpc/server` still builds, because the client type imports that package.

The API must allow the client origin through `CORS_ORIGINS`. Production requires an HTTPS client URL configured in BotFather and `MINI_APP_URL`, plus the existing backend configuration.

Open through Telegram. The client sends the unmodified SDK `initData` as `Authorization: tma ...` on every tRPC request. It does not accept an identity supplied by application UI, create a development login, or store bot credentials. `VITE_API_URL` is public configuration.

The build rejects any module under the repository-root `src/` and the Drizzle, grammY, `@grammyjs/*`, `@aws-sdk/*`, ioredis and Postgres packages. The router import is type-only, so `@trpc/server` stays allowed.

A wish can include a product link and a JPEG, PNG, or WebP photo up to 5 MB. The photo is uploaded with `products.presignImage` and saved as `imageUrl`. That step does not need a live bot token. Local API runs use the placeholder `BOT_TOKEN` in the repository `.env.example`.

Stars invoices open Telegram's payment UI. A paid callback only displays that payment was submitted; the server's successful-payment handler remains responsible for confirming funding. Manual claims remain pending until the owner confirms receipt. Anonymous identities remain controlled by server responses.

Premium checkout is not exposed by the current API. Plan limits display the server rejection; subscription purchasing and real Telegram verification remain integration gates.
