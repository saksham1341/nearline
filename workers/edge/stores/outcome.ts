import type { ErrorCode } from "../../../packages/protocol/index.ts";

export type Outcome<T> = ({ ok: true } & T) | { ok: false; code: ErrorCode };

export function fail(code: ErrorCode): { ok: false; code: ErrorCode } {
  return { ok: false, code };
}
