import type { CellEvent, FeedEvent, ThreadLikedEvent, ThreadRepostedEvent } from "../events.ts";
import type { Services } from "../services.ts";

/**
 * Groups a batch by target and makes one call per target, so a viral thread receives a few
 * aggregated calls per second instead of one per like. Throwing makes the queue retry the batch;
 * every handler is idempotent, so retries are safe.
 */
export async function consumeEvents(events: readonly FeedEvent[], services: Services, now: number): Promise<void> {
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
  await Promise.all([
    ...[...likes].map(([threadId, batch]) => services.thread(threadId).applyLikes(batch, now)),
    ...[...reposts].map(([threadId, batch]) => services.thread(threadId).applyReposts(batch, now)),
    ...[...cells].map(([partition, batch]) => services.cell(partition).apply(partition, batch, now)),
  ]);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
