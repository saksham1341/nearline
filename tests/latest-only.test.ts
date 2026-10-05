import { describe, expect, it } from "vitest";
import { LatestOnly } from "../apps/web/latest-only.ts";

function controlled() {
  const sent: boolean[] = [];
  let active = 0;
  let maxActive = 0;
  const releases: (() => void)[] = [];
  const send = (_key: string, value: boolean) => new Promise<void>((resolve) => {
    sent.push(value);
    active += 1;
    maxActive = Math.max(maxActive, active);
    releases.push(() => { active -= 1; resolve(); });
  });
  const releaseNext = async () => { releases.shift()?.(); await new Promise((r) => setTimeout(r, 0)); };
  return { sent, send, releaseNext, maxActive: () => maxActive };
}

describe("latest-only sending", () => {
  it("sends one request per key at a time, ending on the newest choice", async () => {
    const c = controlled();
    const liker = new LatestOnly(c.send);
    void liker.set("post", true);
    void liker.set("post", false);
    void liker.set("post", true);
    void liker.set("post", false);
    await c.releaseNext();
    await c.releaseNext();
    expect(c.sent).toEqual([true, false]);
    expect(c.maxActive()).toBe(1);
  });

  it("skips a final choice that matches what was already sent", async () => {
    const c = controlled();
    const liker = new LatestOnly(c.send);
    void liker.set("post", true);
    void liker.set("post", false);
    void liker.set("post", true);
    await c.releaseNext();
    await c.releaseNext();
    expect(c.sent).toEqual([true]);
  });

  it("keeps different keys independent", async () => {
    const c = controlled();
    const liker = new LatestOnly(c.send);
    void liker.set("a", true);
    void liker.set("b", true);
    expect(c.sent).toEqual([true, true]);
    await c.releaseNext();
    await c.releaseNext();
  });
});
