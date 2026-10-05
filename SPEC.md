# Nearline
## v1 Product & Technical Specification

**Status:** v1 design; the live chat parts were superseded on 2026-10-05 by the local feed (`docs/superpowers/specs/2026-10-05-local-feed-design.md`). Where this document and that design disagree, the design wins.  
**Stack:** Cloudflare Workers + Durable Objects + D1 + H3  
**Transport:** Hibernating WebSockets  
**Client:** Browser-only web application  
**Content:** Text messages only

---

# 1. Product Definition

Nearline is an extremely lightweight website for casually talking to people physically near the user.

The primary flow is:

1. Open website.
2. Authenticate using a passkey.
3. Grant location permission.
4. Enter the proximity chat immediately.
5. Optionally change proximity scope.
6. Optionally enter a room ID and passphrase.
7. Send and receive text messages.

There are no profiles, room directories, membership lists, friend systems, media uploads, reactions, threads, moderation roles, or account recovery in v1.

The system should feel ephemeral and immediate rather than like a persistent social network.

---

# 2. Product Principles

The implementation should follow these principles.

### 2.1 Geography is a filter, not a room

Geographic areas are not represented as persistent chatrooms.

Every message has a geographic position represented by one canonical H3 cell.

The viewer's current position and selected proximity scope determine whether that message is visible.

### 2.2 Private rooms are filters, not entities

A room does not exist as a database record.

There is no:

- room creation;
- room owner;
- room membership;
- room ACL;
- room metadata;
- room list;
- room discovery mechanism;
- join/leave record.

A room is simply a deterministic tag derived from credentials entered by users.

Messages carrying the same room tag form a filtered view of the geographic message stream.

### 2.3 Threads are the unit of persistence

Posts, replies, likes and reposts belong to a thread. The server keeps a thread only while it is active: every thread is deleted fifteen minutes after its last activity (a reply, a like or a repost).

### 2.4 Delivery is pull-only

Clients poll for feeds and threads. The server never pushes. Feeds are shared and cached per scope cell, room and tab, so a crowd in one place costs about as much as one person.

### 2.5 Location authenticity is not guaranteed

Browser geolocation is trusted sufficiently for the product.

Location spoofing is acceptable.

The system makes no attempt to prove physical presence.

---

# 3. Identity

## 3.1 Authentication

Authentication is exclusively WebAuthn/passkey based.

There are no:

- passwords;
- email addresses;
- phone numbers;
- social-login providers;
- recovery codes.

First visit:

```text
Create passkey
→ authenticate
→ request location
→ enter chat
```

Returning visit:

```text
Authenticate with passkey
→ request/restore location permission
→ enter chat
```

## 3.2 Identity semantics

One WebAuthn credential represents one pseudonymous identity.

For v1:

```text
1 passkey credential = 1 identity
```

If the user's passkey provider syncs the credential between devices, the identity naturally follows.

If another credential is created, it is considered another identity.

Account linking and account recovery are explicitly deferred.

## 3.3 Public identity

The visible author identifier is derived from the credential public key.

Example:

```text
@4f92ac17
```

Recommended derivation:

```text
authorId =
    first 8 hex characters(
        SHA-256(canonicalPublicKey)
    )
```

The full hash should remain available internally so the display length can later be increased if collisions become relevant.

The public UI should not expose the full WebAuthn credential ID.

## 3.4 Identity persistence

A small D1 database is used for permanent credential information.

D1 is **not** used for chat messages.

Minimum conceptual schema:

```sql
users
-----
id
author_hash
created_at

credentials
-----------
credential_id
user_id
public_key
sign_count
created_at
last_used_at
```

Additional WebAuthn metadata may be stored as required by the implementation/library.

---

# 4. Location Model

## 4.1 Browser coordinates

The browser requests geolocation permission.

Location permission is mandatory.

Without location access, the application cannot enter the chat UI.

Raw latitude/longitude is used only in the browser to produce an H3 cell.

The normal chat protocol does not transmit raw coordinates.

## 4.2 Canonical location resolution

Every client position and every message is represented at:

```text
H3 resolution 11
```

Call this:

```text
LOCATION_RESOLUTION = 11
```

H3 resolution 11 has an average hexagon edge length of roughly 28.7 metres.

This resolution serves as the canonical location quantum.

Example:

```ts
type H3Location = string; // always resolution 11
```

## 4.3 Location updates

The browser may receive geolocation changes as frequently as the browser/OS chooses.

The client only sends an update when its **resolution-11 H3 cell changes**.

```text
geolocation event
      ↓
convert lat/lng → H3 r11
      ↓
same r11 as previous?
  yes → ignore
  no  → send position update
```

This prevents GPS jitter from producing excessive backend activity.

---

# 5. Proximity Model

## 5.1 User-facing scopes

v1 exposes exactly three proximity scopes.

Internally:

```text
Wide    → H3 resolution 9
Nearby  → H3 resolution 10
Close   → H3 resolution 11
```

These labels are product copy and may change.

The UI should not expose H3 terminology by default.

Current H3 average edge lengths are approximately:

```text
r9  ≈ 201 m
r10 ≈ 76 m
r11 ≈ 29 m
```

Actual cell dimensions vary geographically.

These values are initial product defaults and should be constants rather than protocol assumptions.

## 5.2 Seven-cell neighborhood

A proximity consists of:

```text
the user's containing cell
+
its immediate H3 neighbors
```

That is normally seven cells:

```text
       A   B
    F    X    C
       E   D
```

Conceptually:

```ts
scopeCells = gridDisk(centerCell, 1);
```

H3 provides hierarchical parent conversion and grid neighborhood operations for this model.

Pentagon topology must be handled by the H3 library rather than assuming there are always exactly six adjacent cells.

## 5.3 Visibility semantics

A user's scope controls **what that user sees**.

It does not control how far that user's messages are broadcast.

Every message simply occurs at its canonical H3 r11 location.

Visibility is therefore viewer-relative.

Given:

```ts
viewer.location: H3 r11
viewer.scope: 9 | 10 | 11

message.location: H3 r11
```

derive:

```ts
viewerCell =
  cellToParent(viewer.location, viewer.scope)

messageCell =
  cellToParent(message.location, viewer.scope)

allowed =
  gridDisk(viewerCell, 1)

visible =
  allowed.includes(messageCell)
```

The sender's selected scope is irrelevant to message visibility for other users.

---

# 6. Rooms

## 6.1 Public chat

Public chat is represented using a reserved empty room tag:

```text
roomTag = ""
```

## 6.2 Filtered rooms

The user may optionally provide:

```text
room ID
passphrase
```

The browser derives:

```text
roomTag =
SHA-256(
  UTF8(roomId)
  || 0x00
  || UTF8(passphrase)
)
```

The delimiter avoids ambiguous concatenations.

The resulting 256-bit value can be transmitted as hexadecimal or base64url.

## 6.3 Room security properties

Room tags are organizational filters, not cryptographic privacy boundaries.

The service may inspect:

- room tags;
- message bodies;
- identities;
- message geography.

Messages are not end-to-end encrypted.

The architecture makes no claim that knowing a room tag or observing backend state cannot reveal room activity.

## 6.4 Active room

A client may view exactly one room/filter at a time.

Connection state therefore contains one:

```ts
roomTag: string
```

Changing room does not require reconnecting the WebSocket.

Previously rendered messages remain on the screen for v1.

New incoming messages follow the newly active filter.

---

# 7. Message Model

Canonical message structure:

```ts
type ChatMessage = {
  id: string;
  ts: number;

  location: string;   // H3 resolution 11
  author: string;     // pseudonymous author hash
  roomTag: string;    // "" means public

  body: string;
};
```

Recommended message IDs:

```text
UUIDv7
```

or another roughly time-sortable globally unique identifier.

IDs exist primarily for:

- deduplication;
- client reconciliation.

## 7.1 Message limits

Suggested initial constants:

```text
MAX_MESSAGE_CHARS = 1000
MAX_MESSAGES_PER_SECOND_PER_USER = 2
BURST_MESSAGES_PER_USER = 5
```

Exact limits are product-tunable.

No rich text is required.

Messages should be treated as plain text and safely escaped during rendering.

---

# 8–16. Local Feed Architecture (replaces sharding, WebSockets and fanout)

The live chat's geographic shard Durable Object, WebSocket protocol and fanout are retired. The system is now:

- **Edge Worker** (stateless): authentication, validation, rate limits, feed assembly, edge caching.
- **ThreadStore** Durable Object, one per thread: the single source of truth for a thread's posts, reply tree, counts, trending score and expiry. It deletes itself when the thread expires.
- **CellIndex** Durable Object, one per partition cell (H3 resolution 7 to 9, splitting and merging with load): references to threads anchored in its cell, with ordering data only.
- **UserState** Durable Object, 65,536 buckets: each user's likes and reposts.
- **Queue** `nearline-feed-events`: propagates follow-on changes between them, batched, at least once, idempotently.
- **Workers KV** `PARTITION_MAP`: which cells are split.

HTTP API: `GET /api/feed`, `GET /api/threads/:id`, `GET /api/me/engagement`, `POST /api/actions`. Full details, including the protocol types, trending formula, partitioning and capacity reasoning, are in `docs/superpowers/specs/2026-10-05-local-feed-design.md`. A plain-language explanation is served at `/how-it-works.html`.

---

# 17. Authentication Flow

Suggested high-level endpoints:

```text
POST /api/auth/register/options
POST /api/auth/register/verify

POST /api/auth/login/options
POST /api/auth/login/verify

GET /api/socket
```

Registration/login challenge state may be held in:

- short-lived signed state;
- KV;
- an auth Durable Object;
- another suitable ephemeral mechanism.

Permanent credential data belongs in D1.

After authentication, issue a secure session credential.

A server-managed HttpOnly secure cookie is preferred over exposing a bearer token to frontend JavaScript unless implementation constraints justify otherwise.

The WebSocket upgrade validates the authenticated session before routing the socket to a geographic DO.

---

# 18. Worker Routing

| Route | Purpose |
|---|---|
| `/api/auth/*` | Passkey registration, login, session and logout |
| `GET /api/feed` | A page of the Latest or Trending feed for a scope cell, range and room |
| `GET /api/threads/:id` | A thread's summary and full reply tree |
| `GET /api/me/engagement` | The signed-in user's likes and reposts for given threads |
| `POST /api/actions` | Post, reply, like, unlike, repost, delete |
| `POST /api/client-error` | Bounded client diagnostics |
| `GET /api/health` | Health check |
| everything else | Static assets |

`POST` requests must carry `Origin` equal to the configured origin.

---

# 19. Rate Limiting and Abuse Foundation

Full moderation is deferred.

However, abuse controls should be built into the protocol from the beginning.

Initial per-identity controls should support:

- message send rate;
- connection creation rate;
- reconnect rate;
- maximum message length;
- malformed protocol rate.

Rate-limit keys should use permanent identity IDs, not IP address alone.

IP-based heuristics may later supplement identity limits.

Future server-side enforcement may add:

- muted identities;
- rejected messages;
- temporary bans;
- permanent bans;
- room-tag bans;
- geographic throttling.

The protocol should therefore allow the server to reject a send without disconnecting the user.

Example:

```json
{
  "type": "error",
  "code": "MESSAGE_REJECTED"
}
```

User blocking and reporting are explicitly outside v1.

---

# 20. Data Boundaries

## D1 contains

```text
permanent pseudonymous user records
WebAuthn credentials
minimal account metadata
future abuse/account flags
```

## Durable Object SQLite contains

- ThreadStore: one thread's posts, counts, score, participants and where its references live, until the thread expires.
- CellIndex: references (thread id, anchor cell, time, ordering snapshot, expiry), idempotency records and tombstones for 20 minutes, per-minute load counts.
- UserState: likes and reposts per user for 24 hours.

## Browser contains

```text
raw geolocation coordinates transiently
current r11 H3 location
room ID/passphrase input
room tag
visible transcript
UI state
```

No global message database exists.

---

# 21. Privacy Posture

The product is intentionally **not privacy-first**.

The service can read message contents.

The service can determine:

- pseudonymous sender;
- approximate message location;
- room tag;
- timestamps;
- geographic movement communicated during an active session.

However, raw latitude/longitude does not need to leave the browser because H3 conversion occurs client-side.

This is an implementation minimization choice, not a security guarantee.

---

# 22. Failure Semantics

## Durable Object restart / hibernation

Required connection state survives via WebSocket attachments.

Ordinary in-memory indexes/caches may disappear and are rebuilt lazily.

Cloudflare explicitly discards in-memory state during Durable Object hibernation/reinitialization, so correctness must not depend on it.

## Neighbor shard unavailable

Local delivery proceeds.

Remote fanout may fail.

v1 does not require distributed transaction semantics or retry queues for cross-shard live delivery.

## Location permission removed

The client stops participating in chat and displays the location-required state.

## WebSocket reconnect

Reconnect to the shard corresponding to the latest known client location. Only messages sent after reconnection can be delivered.

---

# 23. Explicit Non-Goals for v1

The following are intentionally not part of the system:

- email/password authentication;
- identity recovery;
- multiple passkeys per identity;
- user-selected usernames;
- avatars;
- direct messages;
- media;
- reactions;
- threads;
- typing indicators;
- read receipts;
- presence lists;
- user directories;
- room directories;
- room ownership;
- room moderation;
- room membership;
- room persistence;
- end-to-end encryption;
- exact-distance calculations;
- trusted GPS;
- background mobile location;
- push notifications;
- global message search;
- historical archives;
- D1 message persistence;
- block lists;
- reporting UX;
- admin moderation UX.

---

# 24. Important Constants

All of these should live together in one shared configuration module.

```ts
export const LOCATION_RESOLUTION = 11;

export const PROXIMITY_SCOPES = {
  wide: 9,
  nearby: 10,
  close: 11,
} as const;

export const SHARD_RESOLUTION = 5;

export const MAX_MESSAGE_CHARS = 1000;
```

This separation is important:

```text
LOCATION_RESOLUTION
    ≠
VIEW RESOLUTION
    ≠
SHARD RESOLUTION
```

They happen to use the same H3 hierarchy but represent three completely different concerns.

---

# 25. Core Invariants

These should be treated as architectural invariants and tested directly.

### Invariant 1

Every message belongs to exactly one home shard.

```ts
home =
  cellToParent(message.location, 5)
```

### Invariant 2

Every message carries exactly one canonical r11 location.

### Invariant 3

A user's selected proximity affects only that user's view.

### Invariant 4

Geographic visibility is always calculated from:

```text
viewer position
viewer scope
message position
```

### Invariant 5

Rooms are equality filters:

```ts
viewer.roomTag === message.roomTag
```

### Invariant 6

A room has no server-side existence independent of its messages.

### Invariant 7

A browser maintains only one user-facing WebSocket at a time.

### Invariant 8

No shard stores local or forwarded chat messages.

### Invariant 9

Messages sent while a viewer is disconnected are not replayed.

### Invariant 10

Raw browser latitude/longitude is unnecessary to operate the chat backend.

---

# 26. Suggested Repository Shape

```text
/
├─ apps/
│  └─ web/
│     ├─ auth/
│     ├─ chat/
│     ├─ location/
│     └─ websocket/
│
├─ workers/
│  └─ edge/
│     ├─ auth/
│     ├─ durable-objects/
│     │  └─ geo-shard.ts
│     ├─ websocket/
│     └─ index.ts
│
├─ packages/
│  ├─ protocol/
│  ├─ geo/
│  ├─ auth/
│  └─ shared/
│
├─ migrations/
│  └─ d1/
│
└─ wrangler.jsonc
```

`packages/geo` should own all H3 behavior so geographic logic does not become duplicated across browser and Worker code.

---

# 27. Geo API Surface

The geo package should expose semantic functions rather than leaking H3 operations throughout the application.

Example:

```ts
latLngToCanonicalLocation(lat, lng)

locationToShard(location)

locationToScopeCell(location, scope)

cellsVisibleFrom(location, scope)

messageVisibleTo(messageLocation, viewerLocation, scope)

candidateShardsForMessage(messageLocation)
```

Unit-test these aggressively around:

- ordinary cell boundaries;
- shard boundaries;
- H3 pentagons;
- resolution parent transitions.

The rest of the application should not need to understand H3 geometry.

---

# 28. Minimum v1 UI

Unauthenticated:

```text
Nearline

[ Continue with passkey ]
```

After authentication without location:

```text
Location is required to chat with
people around you.

[ Allow location ]
```

Main UI:

```text
------------------------------------------------
@4f92ac17             [ Close ▾ ]   [ Room ]
------------------------------------------------

@82cd109a
anyone near the station?

@4f92ac17
yeah

@91ad723f
👋

------------------------------------------------
Message...                              [ Send ]
------------------------------------------------
```

Room control:

```text
Room ID
[________________]

Passphrase
[________________]

[ Enter ]
```

Active filtered room:

```text
Room active              [ Leave room ]
```

Room credentials need not be displayed after derivation.

---

# 29. Initial Implementation Order

### Phase 1 — Local single-shard chat

Implement:

- passkey auth;
- mandatory location;
- H3 r11 conversion;
- one geo DO;
- hibernating WebSocket;
- public chat;
- three scopes;
- local visibility predicate.

### Phase 2 — Rooms

Add:

- room ID/passphrase UI;
- client room-tag derivation;
- connection room updates;
- room filtering.

### Phase 3 — Client transcript

Add:

- bounded browser-session transcript;
- message deduplication;
- local connection and neighborhood event markers.

### Phase 4 — Geographic sharding

Add:

- r5 DO selection;
- shard migration;
- cross-shard RPC fanout.

### Phase 5 — Basic abuse controls

Add:

- per-identity rate limiting;
- message length enforcement;
- server rejection codes;
- basic administrative ban primitives.

---

# 30. v1 Architecture Summary

```text
                         ┌─────────────────┐
                         │       D1        │
                         │                 │
                         │ Passkey users   │
                         │ Credentials     │
                         └────────┬────────┘
                                  │
                                  │ auth
                                  │
┌───────────────┐          ┌──────▼──────┐
│    Browser    │◄────────►│   Worker    │
│               │ WebAuthn │             │
│ GPS → H3 r11  │          │ Auth/router │
│ Transcript    │          └──────┬──────┘
│ Room filter   │                 │
└───────┬───────┘                 │ route by
        │                         │ H3 r5
        │ Hibernating WS          │
        ▼                         ▼
┌───────────────────────────────────────┐
│        Geographic Durable Object      │
│               H3 r5                   │
│                                       │
│ WebSocket attachments                 │
│ Realtime filtering                    │
│ Rate limiting                         │
│ No chat message persistence           │
└───────────────┬───────────────────────┘
                │
                │ short-lived RPC
                │ when geography overlaps
                ▼
┌───────────────────────────────────────┐
│       Neighbor Geographic DO(s)       │
│                                       │
│ filter against connected viewers      │
│ do not persist forwarded copy         │
└───────────────────────────────────────┘
```

The core conceptual model can be reduced to:

```text
message =
    identity
  + text
  + time
  + H3 location
  + room tag

viewer =
    identity
  + H3 location
  + proximity scope
  + room tag
```

And delivery is simply:

```ts
deliver =
  sameRoom(message, viewer)
  &&
  insideViewerNeighborhood(message, viewer)
```

Everything else exists to make that predicate work efficiently and reliably across Cloudflare's edge.
