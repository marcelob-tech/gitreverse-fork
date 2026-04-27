import { createHash } from "crypto";
import type { NextRequest } from "next/server";

/* Salt for IP hashing. The default below provides only token protection since
   it lives in the public source tree — anyone can recompute hashes for the
   IPv4 space. Set VIEWS_IP_SALT in the deployment environment to a long random
   secret for meaningful protection of stored hashes. */
const DEFAULT_IP_HASH_SALT = "gitreverse-views-v1";

export function getIpHashSalt(): string {
  return process.env.VIEWS_IP_SALT?.trim() || DEFAULT_IP_HASH_SALT;
}

export function isDefaultIpHashSaltInProduction(): boolean {
  return (
    getIpHashSalt() === DEFAULT_IP_HASH_SALT &&
    process.env.NODE_ENV === "production"
  );
}

/** Derive a stable, privacy-preserving hash of the visitor IP.
 *
 *  Header trust order:
 *  1. `x-real-ip` — set by Vercel (and most reverse proxies) directly from
 *     the connecting socket, so it cannot be spoofed by the client.
 *  2. `x-forwarded-for` — first non-empty entry. Less trustworthy (the client
 *     can prepend arbitrary values), but better than nothing for non-Vercel
 *     deployments. We skip empty entries to avoid the `,real-ip` empty-prefix
 *     bypass where `split(",")[0]` would otherwise return "".
 */
export function hashVisitorIp(req: NextRequest): string | null {
  const salt = getIpHashSalt();
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return createHash("sha256")
      .update(`${salt}:${realIp}`)
      .digest("hex");
  }

  const xffFirst = req.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (xffFirst) {
    return createHash("sha256")
      .update(`${salt}:${xffFirst}`)
      .digest("hex");
  }

  return null;
}
