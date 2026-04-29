import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { hashVisitorIp } from "@/lib/visitor-ip";
import { checkActiveSubscriber } from "@/lib/subscriber";
import { SUBSCRIBER_EMAIL_HEADER } from "@/lib/subscriber-constants";

const DAILY_LIMIT = 3;
const RATE_LIMIT_RPC_TIMEOUT_MS = 2500;

export type CustomReverseRateLimitAction = "deep" | "manual";

/** Skip DB-backed daily limits while developing locally or when explicitly opted out. */
function shouldSkipCustomReverseRateLimit(req: NextRequest): boolean {
  if (process.env.GITREVERSE_SKIP_CUSTOM_REVERSE_RATE_LIMIT === "true") {
    return true;
  }
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** Enforce daily per-IP limits for non-cached custom reverse. Returns a 429
 * response when over limit; returns `null` to continue (including fail-open on
 * timeout/DB errors). */
export async function enforceCustomReverseRateLimit(
  req: NextRequest,
  isDeep: boolean
): Promise<NextResponse | null> {
  if (shouldSkipCustomReverseRateLimit(req)) {
    return null;
  }

  const subscriberEmail = req.headers.get(SUBSCRIBER_EMAIL_HEADER)?.trim();
  if (subscriberEmail) {
    const active = await checkActiveSubscriber(subscriberEmail);
    if (active === true) {
      return null;
    }
  }

  const supabase = getSupabase();
  if (!supabase) return null;

  const action: CustomReverseRateLimitAction = isDeep ? "deep" : "manual";
  const ipHash = hashVisitorIp(req);

  try {
    const rpcPromise = supabase.rpc("check_and_increment_usage", {
      p_ip_hash: ipHash ?? "",
      p_action: action,
      p_limit: DAILY_LIMIT,
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("rl-timeout")), RATE_LIMIT_RPC_TIMEOUT_MS)
    );
    const { data, error } = await Promise.race([rpcPromise, timeoutPromise]);
    if (error) {
      console.warn("[custom-reverse] rate limit RPC error:", error.message);
      return null;
    }
    const payload = data as { allowed?: unknown } | null;
    const allowed =
      payload != null &&
      typeof payload === "object" &&
      payload.allowed === true;
    if (!allowed) {
      return NextResponse.json(
        {
          error: "daily_limit_reached",
          action,
          remaining: 0,
        },
        { status: 429 }
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message !== "rl-timeout") {
      console.warn("[custom-reverse] rate limit:", e.message);
    }
    // Timeout or network — fail open
  }
  return null;
}
