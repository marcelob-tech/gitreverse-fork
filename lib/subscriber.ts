import { getSupabase } from "@/lib/supabase";

const VERIFY_RETRY_MS = 1500;
const VERIFY_MAX_ATTEMPTS = 3;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Resolves payer email from synced `stripe.checkout_sessions` (retries for webhook lag). */
export async function getEmailFromCheckoutSession(
  sessionId: string
): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt++) {
    const { data, error } = await supabase.rpc(
      "get_email_from_checkout_session",
      { p_session_id: sessionId }
    );
    if (error) {
      console.warn(
        "[subscriber] get_email_from_checkout_session:",
        error.message
      );
      if (attempt < VERIFY_MAX_ATTEMPTS - 1) await sleep(VERIFY_RETRY_MS);
      continue;
    }
    const email = typeof data === "string" ? data.trim() : "";
    if (email) return email;
    if (attempt < VERIFY_MAX_ATTEMPTS - 1) await sleep(VERIFY_RETRY_MS);
  }
  return null;
}

/** Whether `email` has an active subscription in synced `stripe` tables. */
export async function checkActiveSubscriber(
  email: string
): Promise<boolean | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const trimmed = email.trim();
  if (!trimmed) return false;

  const { data, error } = await supabase.rpc("check_active_subscriber", {
    p_email: trimmed,
  });
  if (error) {
    console.warn("[subscriber] check_active_subscriber:", error.message);
    return null;
  }
  return data === true;
}
