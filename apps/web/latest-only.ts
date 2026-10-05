/**
 * Sends at most one request per key at a time. Changes made while a request is in flight collapse
 * into the newest one, which is sent next unless it matches what was just sent. Rapid toggles
 * therefore reach the server in order and end on the user's last choice.
 */
export class LatestOnly<T> {
  private readonly inFlight = new Set<string>();
  private readonly queued = new Map<string, T>();

  constructor(private readonly send: (key: string, value: T) => Promise<void>) {}

  async set(key: string, value: T): Promise<void> {
    if (this.inFlight.has(key)) {
      this.queued.set(key, value);
      return;
    }
    this.inFlight.add(key);
    try {
      let next: T | undefined = value;
      while (next !== undefined) {
        const sending: T = next;
        await this.send(key, sending);
        next = this.queued.get(key);
        this.queued.delete(key);
        if (next === sending) next = undefined;
      }
    } finally {
      this.inFlight.delete(key);
    }
  }
}
