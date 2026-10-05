# Nearline

A local, X-style feed for the people physically around you: posts, replies, likes and reposts, filtered by where you are. Every thread fades fifteen minutes after its last activity. Built on Cloudflare Workers, Durable Objects, Queues, Workers KV, D1, H3 and passkeys.

- How it works, in plain language: [`public/how-it-works.html`](./public/how-it-works.html) (served at `/how-it-works.html`)
- Design: [`docs/superpowers/specs/2026-10-05-local-feed-design.md`](./docs/superpowers/specs/2026-10-05-local-feed-design.md)
- Original v1 specification: [`SPEC.md`](./SPEC.md)

## Local development

Requirements: Node.js 22.5+ (the tests use `node:sqlite`), a WebAuthn-capable browser, and a Cloudflare account.

```bash
npm install
npm test
npm run build
```

### UI preview (no backend)

```bash
npm run preview          # http://localhost:8788
```

Serves the real web client against a fake in-page API (`dev/preview/mock-api.js`) with a fixed location and a signed-in user. Posting, replying, liking, reposting and deleting work in memory. `app.js` rebuilds on every change under `apps/` and `packages/`; reload the page to see HTML and CSS edits. Add `#gate` to the URL for the sign-in screen, `#empty` for an empty feed, `#thread` to open the first thread.

### Full Worker

Running the Worker locally needs a `.dev.vars` file:

```
SESSION_KEY=replace-with-at-least-32-random-characters
RP_ID=localhost
ORIGIN=http://localhost:8787
```

then:

```bash
npx wrangler d1 migrations apply proximity-chat-auth --local
npm run dev
```

## Deploying

One-time setup per environment:

```bash
npx wrangler queues create nearline-feed-events
npx wrangler queues create nearline-feed-events-dlq
npx wrangler kv namespace create PARTITION_MAP        # put the id in wrangler.jsonc
openssl rand -base64 48 | npx wrangler secret put SESSION_KEY
npx wrangler d1 migrations apply proximity-chat-auth --remote
```

Then `npm run deploy`.

## Commands

- `npm test` — unit, store and handler tests (stores run against real SQLite via `node:sqlite`)
- `npm run typecheck` — strict TypeScript for the Worker and the browser app
- `npm run build` — browser bundle plus typecheck
- `npm run dev` — build the browser bundle and start Wrangler
- `npm run preview` — the web client against a fake API, for UI work without deploying

## Structure

- `apps/web` — the browser app: polling, state, rendering
- `packages/geo` — the only module that uses H3
- `packages/feed` — trending scores, reply trees, partitions, feed ordering
- `packages/protocol` — HTTP request and response types and validation
- `packages/shared` — constants, encoding, UUIDv7, access tokens
- `workers/edge` — the Worker: API handlers, stores, Durable Objects, queue consumer, auth
- `migrations/d1` — accounts, passkeys and sessions
