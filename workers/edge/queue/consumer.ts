import type { CellEvent, FeedEvent, ThreadLikedEvent, ThreadRepostedEvent } from "../events.ts";
import type { Services } from "../services.ts";

/**
 * Groups a batch by target and makes one call per target, so a viral thread receives a few
 * aggregated calls per second instead of one per like. Returns the events whose target call
 * failed, so only those are retried; every handler is idempotent, so a retry is always safe.
 */
export async function consumeEvents(events: readonly FeedEvent[], services: Services, now: number): Promise<FeedEvent[]> {
  const likes = new Map<string, ThreadLikedEvent[]>();
  const reposts = new Map<string, ThreadRepostedEvent[]>();
  const cells = new Map<string, CellEvent[]>();
  for (const event of events) {
    switch (event.type) {
      case "thread.liked":
        push(likes, event.threadId, event);
        break;
      case "thread.reposted":
        push(reposts, event.threadId, event);
        break;
      default:
        push(cells, event.partition, event);
    }
  }
  const groups: { events: FeedEvent[]; run: () => Promise<void> }[] = [
    ...[...likes].map(([threadId, batch]) => ({ events: batch, run: () => services.thread(threadId).applyLikes(batch, now) })),
    ...[...reposts].map(([threadId, batch]) => ({ events: batch, run: () => services.thread(threadId).applyReposts(batch, now) })),
    ...[...cells].map(([partition, batch]) => ({ events: batch, run: () => services.cell(partition).apply(partition, batch, now) })),
  ];
  const results = await Promise.allSettled(groups.map((group) => group.run()));
  const failed: FeedEvent[] = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn("Feed event group failed", result.reason);
      failed.push(...groups[index]!.events);
    }
  });
  return failed;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
