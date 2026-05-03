import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

const ALLOWED_REASONS = new Set([
  "too_expensive",
  "not_ready_yet",
  "just_browsing",
  "other",
]);

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || !("reason" in body)) {
    return NextResponse.json(
      { error: "Expected JSON body with reason." },
      { status: 400 }
    );
  }

  const reason = (body as { reason: unknown }).reason;
  if (typeof reason !== "string" || !ALLOWED_REASONS.has(reason)) {
    return NextResponse.json({ error: "Invalid reason." }, { status: 400 });
  }

  const rawOtherText = (body as { other_text?: unknown }).other_text;
  const otherText =
    reason === "other" && typeof rawOtherText === "string"
      ? rawOtherText.trim().slice(0, 1000)
      : null;

  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabase.from("checkout_abandonment_responses").insert({
    reason,
    ...(otherText ? { other_text: otherText } : {}),
  });

  if (error) {
    console.warn("[checkout-abandonment]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
