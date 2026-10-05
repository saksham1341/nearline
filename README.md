# Nearline

A browser-only, location-filtered text chat built for Cloudflare Workers, Durable Objects, D1, H3, and passkeys. The implementation follows [`SPEC.md`](./SPEC.md): geography and rooms are backend connection filters, delivery is live-only, and the browser owns its visible transcript.

## Local development

Requirements: Node.js 20+, a WebAuthn-capable browser, and a Cloudflare account for deployed D1/Workers resources.

```bash
npm install
npm run build
npx wrangler d1 create proximity-chat-auth
```

Put the returned database ID in `wrangler.jsonc`, then initialize local D1 and run:

```bash
npx wrangler d1 migrations apply proximity-chat-auth --local
npm run dev
```

For production, set `RP_ID` to the site's hostname and `ORIGIN` to its exact HTTPS origin in the deployed Worker environment. Apply the remote D1 migration before deploying:

```bash
npx wrangler d1 migrations apply proximity-chat-auth --remote
npm run deploy
```

## Commands

- `npm test` — core geography, room-filter, and identifier invariants
- `npm run typecheck` — strict TypeScript validation
- `npm run build` — browser bundle plus typecheck
- `npm run dev` — build the browser bundle and start Wrangler

## Structure

- `apps/web` — dependency-light browser client and socket lifecycle
- `packages/geo` — the only module that directly uses H3
- `packages/protocol` — shared frames, message types, and room predicate
- `packages/shared` — constants, encoding, and UUIDv7
- `workers/edge` — auth/router Worker and geographic Durable Object
- `migrations/d1` — permanent passkey identity/session schema

The development defaults use `localhost` for the WebAuthn relying-party ID. Raw coordinates are converted to H3 resolution 11 in the browser and are never sent to the backend.
