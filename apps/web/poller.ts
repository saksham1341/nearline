import { POLL_BACKOFF_AFTER_MS, POLL_MAX_MS } from "../../packages/shared/constants.ts";

/** Base interval while things change; doubling after a quiet minute, capped. */
export function nextDelay(base: number, current: number, unchangedForMs: number): number {
  if (unchangedForMs < POLL_BACKOFF_AFTER_MS) return base;
  return Math.min(POLL_MAX_MS, Math.max(base, current * 2));
}

/** Runs `task` repeatedly. `task` resolves true when it found something new. */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private lastChange: number;
  private running = false;
  private inFlight = false;

  constructor(
    private readonly base: number,
    private readonly task: () => Promise<boolean>,
    private readonly clock: () => number = Date.now,
  ) {
    this.delay = base;
    this.lastChange = clock();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Something happened (a user action, a tab switch): poll now and reset the backoff. */
  poke(): void {
    this.lastChange = this.clock();
    this.delay = this.base;
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    let changed = false;
    try {
      changed = await this.task();
    } catch {
      changed = false;
    } finally {
      this.inFlight = false;
    }
    if (changed) this.lastChange = this.clock();
    this.delay = changed ? this.base : nextDelay(this.base, this.delay, this.clock() - this.lastChange);
    if (this.running && this.timer === null) this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.delay);
  }
}
