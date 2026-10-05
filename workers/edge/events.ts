/** What a cell index needs to place and order one anchor of a thread. */
export interface RefPayload {
  threadId: string;
  anchorAt: number;
  kind: "root" | "repost";
  byAuthor: string;
  location: string;
  roomTag: string;
  expiresAt: number;
  score: number;
  scoreAt: number;
  participantCount: number;
}

export interface ThreadLikedEvent {
  eventId: string;
  type: "thread.liked";
  threadId: string;
  postId: string;
  userId: string;
  delta: 1 | -1;
  /** True on this user's first like anywhere in the thread: only then does it score. */
  first: boolean;
  at: number;
}

export interface ThreadRepostedEvent {
  eventId: string;
  type: "thread.reposted";
  threadId: string;
  userId: string;
  first: boolean;
  location: string;
  partition: string;
  byAuthor: string;
  at: number;
}

export interface RefAddedEvent {
  eventId: string;
  type: "ref.added";
  partition: string;
  ref: RefPayload;
}

export interface ThreadUpdatedEvent {
  eventId: string;
  type: "thread.updated";
  partition: string;
  threadId: string;
  expiresAt: number;
  score: number;
  scoreAt: number;
  participantCount: number;
}

export interface ThreadExpiredEvent {
  eventId: string;
  type: "thread.expired";
  partition: string;
  threadId: string;
  at: number;
}

export type ThreadEvent = ThreadLikedEvent | ThreadRepostedEvent;
export type CellEvent = RefAddedEvent | ThreadUpdatedEvent | ThreadExpiredEvent;
export type FeedEvent = ThreadEvent | CellEvent;
