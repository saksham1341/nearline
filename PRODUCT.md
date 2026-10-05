# Product

<!-- impeccable:product-schema 1 -->

> The owner gave no direction for this record ("I am giving no direction"). Everything below is inferred from SPEC.md, README.md and the shipped client, and is unconfirmed until the owner reviews it.

## Platform

web

## Users
People physically near each other who want to talk casually with whoever else is around right now: a campus quad, a festival field, a stadium section, a neighbourhood, a train platform. They open the site on a phone, mostly outdoors or in transit, often for a few minutes at a time. A second group uses it on a laptop at a desk or in a café. (Inferred.)

## Product Purpose
Nearline is an extremely lightweight website for talking to people physically near you. Open the site, authenticate with a passkey, grant location, and you are in the local conversation immediately. Success is the time from opening the site to reading or sending a message, plus the feeling that the line is live and local.

## Positioning
Geography is a filter, not a room. Each message has one position (an H3 cell), and what you see depends on where you are and how far you choose to listen. Nothing is stored: delivery is live-only, and the browser owns its transcript. A neighbouring product with rooms, profiles or history could not honestly claim this.

## Operating Context
- Phone-first, one-handed use, often outdoors in daylight or at night in transit; also desktop browser use.
- Passkey sign-in (no username or password), browser geolocation, a WebSocket that may drop and reconnect.
- Three listening ranges: Close (about the same block), Nearby (default, a few blocks), Wide (the wider neighbourhood). These correspond to H3 resolutions 11, 10 and 9 with a one-cell ring.
- Optional private filter: a room ID plus a passphrase hashed into a tag. Only people nearby using the same pair see those messages.

## Capabilities and Constraints
- Text messages only, up to 1,000 characters. Rate limited.
- No profiles, room directories, membership lists, friends, media, reactions, threads, moderation roles or account recovery.
- Author identity is an 8-character hex label derived from the passkey; it is the only identity shown.
- Messages missed while disconnected are gone by design.
- Raw coordinates never leave the browser; only the H3 cell does.
- The client is a dependency-light, framework-free TypeScript bundle (esbuild) served as static assets by a Cloudflare Worker.

## Brand Commitments
Name: Nearline. Existing voice is short, calm and plain ("Talk to people nearby.", "Quiet here. Start the line."). No other binding visual commitment exists.

## Evidence on Hand
No users, testimonials, metrics or press. Never invent counts of people nearby, activity statistics or claims of popularity.

## Product Principles
1. Immediate: from open to talking in as few steps as possible.
2. Ephemeral: the interface should feel like a live line, not an archive.
3. Local: distance is the organising idea, and the interface should make range legible.
4. Anonymous by default: identity is a short label, never a profile.
5. Honest: never imply presence, history or delivery guarantees the system does not provide.

## Accessibility & Inclusion
Readable outdoors on phones (strong contrast, large touch targets), keyboard usable on desktop, respects reduced motion. No specific standard was set; WCAG 2.2 AA is the assumed floor.
