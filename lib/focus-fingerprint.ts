import { createHash } from "node:crypto";

/** MD5 hex of UTF-8 focus — must match `md5(focus::text)` in Postgres (`focus_fingerprint`). */
export function focusFingerprint(focus: string): string {
  return createHash("md5").update(focus, "utf8").digest("hex");
}

/** Upstream / cache key for Deep Reverse. */
export const DEEP_REVERSE_FOCUS = "[deep] whole codebase";
