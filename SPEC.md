# Nearline
## v1 Product & Technical Specification

**Status:** Locked v1 design  
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

### 2.3 The client owns its transcript

The visible conversation accumulated by the browser is primarily client state.

Changing location, proximity scope, or room does not clear messages already displayed.

The backend does not retain chat history.

### 2.4 Delivery is live-only

Messages are delivered only to eligible connections that are active when the message is sent.

Temporary disconnections and reconnects may therefore miss messages. This is an intentional part of the ephemeral product model rather than a gap to recover.

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

# 8. Durable Object Sharding

## 8.1 Shard resolution

Geographic Durable Objects are keyed at:

```text
H3 resolution 5
```

Call this:

```text
SHARD_RESOLUTION = 5
```

An H3 r5 hexagon has an average area around 253 km².

This gives geographically broad objects comparable to the earlier intent behind using coarse geohash infrastructure cells.

The shard resolution is infrastructural and completely independent of visible proximity scopes.

## 8.2 Shard ownership

For any canonical r11 location:

```ts
shardId =
  cellToParent(location, SHARD_RESOLUTION)
```

Every location therefore has exactly one home shard.

Every message is persisted exactly once, by its home shard.

## 8.3 Client coordinator

A connected client has exactly one WebSocket.

Its coordinator DO is the shard corresponding to the client's current location.

```ts
coordinator =
  cellToParent(client.location, 5)
```

When the user moves inside the same r5 shard:

```text
send position event
```

When the user crosses into another r5 shard:

```text
establish socket with new coordinator
close old socket after transition
```

The browser transcript remains unchanged.

---

# 9. WebSocket Architecture

Cloudflare Durable Objects' Hibernation WebSocket API is used.

Cloudflare recommends this API for Durable Object WebSocket servers; connected clients can remain attached while the object's in-memory JavaScript state is discarded during idle periods.

## 9.1 Connection attachment

All state necessary to reconstruct a connection after hibernation is stored in the WebSocket attachment.

Conceptually:

```ts
type ConnectionAttachment = {
  version: 1;

  userId: string;
  author: string;

  location: string;    // H3 r11
  scope: 9 | 10 | 11;
  roomTag: string;

  connectedAt: number;
};
```

Cloudflare's `serializeAttachment` / `deserializeAttachment` mechanism exists specifically for retaining per-connection metadata across hibernation.

Ordinary in-memory maps may be used as caches but must never be the only source of required connection metadata.

---

# 10. WebSocket Protocol

Messages use small JSON frames initially.

Binary encoding is unnecessary for v1.

## 10.1 Client → Server

### Position

```json
{
  "type": "position",
  "location": "8b..."
}
```

Server verifies:

- valid H3 index;
- exactly r11;
- plausible format.

The server does not verify physical authenticity.

### Scope

```json
{
  "type": "scope",
  "scope": 10
}
```

Only:

```text
9
10
11
```

are accepted.

### Room

```json
{
  "type": "room",
  "tag": "..."
}
```

Public:

```json
{
  "type": "room",
  "tag": ""
}
```

### Message

```json
{
  "type": "message",
  "id": "...",
  "body": "anyone here?"
}
```

The server must ignore any client-supplied:

- author;
- timestamp;
- location;
- identity.

Those are attached server-side using authenticated connection state.

## 10.2 Server → Client

### Ready

```json
{
  "type": "ready",
  "author": "4f92ac17",
  "scope": 10,
  "roomTag": ""
}
```

### Message

```json
{
  "type": "message",
  "message": {
    "id": "...",
    "ts": 1790950000000,
    "location": "...",
    "author": "4f92ac17",
    "roomTag": "",
    "body": "hello"
  }
}
```

The frontend does not need to expose the message location.

### Error

```json
{
  "type": "error",
  "code": "RATE_LIMITED"
}
```

Errors should use stable machine-readable codes.

---

# 11. Message Ingestion

When authenticated client `A` sends text:

```text
1. Validate body.
2. Apply rate limit.
3. Read author from authenticated connection.
4. Read current r11 location from connection.
5. Read room tag from connection.
6. Generate authoritative timestamp.
7. Create message.
8. Fan out locally.
9. Forward to relevant neighboring shards.
10. ACK sender if desired.
```

The client cannot choose a different geographic origin for an individual message.

Moving requires a position event first.

---

# 12. Local Fanout

For every active connection in the shard:

```ts
function shouldDeliver(
  viewer: ConnectionAttachment,
  message: ChatMessage
): boolean {
  if (viewer.roomTag !== message.roomTag)
    return false;

  const viewerCell =
    cellToParent(viewer.location, viewer.scope);

  const messageCell =
    cellToParent(message.location, viewer.scope);

  return gridDisk(viewerCell, 1)
    .includes(messageCell);
}
```

This single predicate is canonical for realtime fanout and future server-side filtering.

There must not be separate definitions of geographic visibility in different subsystems.

For the expected initial scale of hundreds of users per shard, v1 may simply scan connected sockets when delivering a message.

Optimization may be introduced only after measurement.

---

# 13. Cross-Shard Fanout

A proximity neighborhood may cross an r5 DO boundary.

This is expected behavior.

The client does not open additional sockets.

Instead, the message's home shard forwards the message to every **candidate shard that could contain an eligible viewer**.

## 13.1 Candidate calculation

For maximum correctness and still-trivial computation:

For each supported scope:

```text
r9
r10
r11
```

perform:

```ts
messageAtScope =
  cellToParent(message.location, scope)

possibleViewerCenters =
  gridDisk(messageAtScope, 1)

for each center:
  shard =
    cellToParent(center, 5)

add shard to Set
```

Pseudo-code:

```ts
function candidateShards(messageR11: string) {
  const shards = new Set<string>();

  for (const scope of [9, 10, 11]) {
    const cell = cellToParent(messageR11, scope);

    for (const nearby of gridDisk(cell, 1)) {
      shards.add(cellToParent(nearby, 5));
    }
  }

  return shards;
}
```

Remove the originating shard from the remote-forward list.

In practice, nearly all messages should require only local delivery; cross-DO forwarding primarily occurs near shard boundaries.

## 13.2 DO-to-DO communication

Cross-shard messages use short-lived Durable Object RPC/fetch calls.

Do **not** maintain outbound DO-to-DO WebSockets.

Cloudflare hibernation applies to server-side accepted sockets, while active outbound WebSockets prevent the originating DO from hibernating.

Remote call:

```text
origin shard
    ↓
targetShard.deliver(message)
    ↓
target performs local shouldDeliver()
```

The target shard delivers the forwarded message only to currently eligible connections.

---

# 14. Live-Only Message Delivery

Chat messages are never written to D1 or Durable Object storage.

The originating shard constructs the authoritative message, scans currently connected sockets, applies the canonical visibility predicate, and forwards the message to candidate neighboring shards for the same live-only filtering.

The Durable Object's SQLite storage may hold operational abuse-control state such as per-identity rate-limit buckets, but never message bodies or chat history.

---

# 15. Disconnect Semantics

Delivery is best effort and only occurs while a viewer is connected.

On reconnect, the client resumes receiving new messages from its current location, scope, and room. Messages sent during the interruption are permanently missed. The client may render local session markers such as connected, disconnected, and neighborhood changed inside its existing transcript.

---

# 16. Client Transcript Behavior

The browser maintains the displayed message list for the life of the page/session.

The following do **not** clear already displayed messages:

- location changes;
- crossing shard boundaries;
- changing proximity scope;
- entering a room;
- returning to public chat.

These actions only affect subsequent delivery.

This behavior is explicitly experimental and may be changed later without modifying backend semantics.

Messages should be deduplicated by ID.

A bounded client transcript should eventually be introduced to prevent unbounded memory growth, e.g.:

```text
last 1000–5000 rendered messages
```

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

The outer Worker is responsible for:

- serving the frontend;
- WebAuthn API endpoints;
- session validation;
- WebSocket upgrade validation;
- selecting the client's geographic Durable Object.

Initial connection request must include the client's r11 H3 location.

Conceptually:

```text
GET /api/socket?location=<h3-r11>
```

Worker:

```ts
validateSession();
validateH3R11(location);

const shard =
  cellToParent(location, 5);

const id =
  GEO_DO.idFromName(shard);

return GEO_DO
  .get(id)
  .fetch(request);
```

Once connected, ordinary movement inside the same shard is sent through the socket.

Crossing an r5 boundary causes the client to establish a socket routed to the new DO.

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

## Geographic Durable Object SQLite contains

```text
operational abuse-control state
no chat messages
```

## WebSocket attachments contain

```text
authenticated user identity
current H3 r11 position
current scope
current room tag
connection metadata
```

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
