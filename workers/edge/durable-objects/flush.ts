import type { FeedEvent } from "../events.ts";

/** Cloudflare Queues accepts at most 100 messages per sendBatch. */
export const QUEUE_BATCH_LIMIT = 100;
/** How soon a failed send is retried. */
export const OUTBOX_RETRY_MS = 5_000;

export interface OutboxSource {
  pendingEvents(limit: number): FeedEvent[];
  ackEvents(eventIds: readonly string[]): void;
}

/**
 * Sends an outbox to the queue in batches the queue accepts, acknowledging each batch once sent.
 * Returns false if a send failed; whatever was not sent stays in the outbox for the next attempt.
 */
export async function flushOutbox(source: OutboxSource, queue: Queue<FeedEvent>): Promise<boolean> {
  for (let batch = source.pendingEvents(QUEUE_BATCH_LIMIT); batch.length > 0; batch = source.pendingEvents(QUEUE_BATCH_LIMIT)) {
    try {
      await queue.sendBatch(batch.map((body) => ({ body })));
    } catch (error) {
      console.warn("Queue send failed; will retry from the outbox", error);
      return false;
    }
    source.ackEvents(batch.map((event) => event.eventId));
  }
  return true;
}
