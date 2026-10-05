# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
People physically near each other who want to know, and say, what is happening around them right now: a campus, a festival, a stadium, a neighbourhood, a street, a train platform. Mostly on a phone, outdoors or in transit, often for a few minutes at a time; sometimes on a laptop.

## Product Purpose
Nearline is "what's happening here": a local, X-style feed of posts, replies, likes and reposts from the people physically around you. Open it, sign in with a passkey, allow location, and you see what the place is talking about. Nothing is kept: a thread fades fifteen minutes after its last activity, and inside a thread every quiet branch fades on its own while active ones stay. Success is how quickly someone gets a feel for what is going on around them and joins in.

## Positioning
X answers "what's happening" for the world; Nearline answers it for this place, this hour. Geography is a filter, not a room: each post is anchored to where it was made (an H3 cell), and you see what is anchored within your chosen range. Reposts carry a thread to where the reposter stands, so things spread hand to hand. Conversations are alive only while people tend them.

## Operating Context
- Phone-first, one-handed, often outdoors in daylight or at night; also desktop.
- Passkey sign-in, browser geolocation, polling every few seconds (no push).
- Three ranges: Close (about a block), Nearby (default, a few blocks), Wide (the neighbourhood).
- Two feeds: Latest (newest first) and Trending (decayed engagement: like 1, repost 2, reply 27, author replies 150; half-life 5 minutes; at least two participants).
- Threads have a reply tree of any depth; the client shows four levels and then "continue thread".
- Optional private filter: room ID plus passphrase, hashed; only people nearby using the same pair see those threads.

## Capabilities and Constraints
- Text only, up to 1,000 characters per post; 500 posts per thread.
- Post, reply (to any post), like, unlike, repost (once per person per thread), delete own posts (a post with replies becomes "[deleted]").
- Every thread and every branch fades 15 minutes after its last activity; the remaining life is shown per post.
- Identity is an anonymous 8-hex label derived from the passkey, with a colour derived from it. No profiles, follows, media, notifications, search or moderation roles.
- Raw coordinates never leave the browser.
- Framework-free TypeScript client (esbuild), static assets served by a Cloudflare Worker. A public explainer page (`/how-it-works`) describes the whole system.

## Brand Commitments
Name: Nearline. Line: "It's what's happening here." Voice is short, plain and warm. No other binding visual commitment; the previous road-marking look is retired.

## Evidence on Hand
No users, testimonials, metrics or press. Never invent counts of people nearby, activity statistics or popularity claims.

## Product Principles
1. Here and now: everything shown is from this place and this hour.
2. Alive or gone: what people tend stays; what they leave fades, visibly.
3. Range is legible: you always know how far you are listening.
4. Anonymous by default: a label and a colour, never a profile.
5. Honest: never imply presence, permanence or reach the system does not have.

## Accessibility & Inclusion
Readable outdoors on phones (strong contrast, large touch targets), keyboard usable on desktop, respects reduced motion. WCAG 2.2 AA is the floor.
