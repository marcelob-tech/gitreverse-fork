import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";

function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key, {
    apiVersion: "2025-02-24.acacia",
  });
}

export async function POST(req: NextRequest) {
  const stripe = getStripeClient();
  if (!stripe) {
    return NextResponse.json(
      {
        error: "stripe_not_configured",
        message: "STRIPE_SECRET_KEY is not set",
      },
      { status: 503 }
    );
  }

  const priceId = process.env.STRIPE_PRICE_ID?.trim();
  if (!priceId) {
    return NextResponse.json(
      {
        error: "stripe_not_configured",
        message: "STRIPE_PRICE_ID is not set",
      },
      { status: 503 }
    );
  }

  const origin =
    req.headers.get("origin")?.trim() || "https://gitreverse.com";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/`,
      allow_promotion_codes: true,
    });

    const url = session.url;
    if (!url) {
      return NextResponse.json(
        { error: "checkout_failed", message: "Stripe returned no checkout URL" },
        { status: 502 }
      );
    }

    return NextResponse.json({ url });
  } catch (err) {
    console.error("[create-checkout]", err);
    return NextResponse.json(
      {
        error: "checkout_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 502 }
    );
  }
}
