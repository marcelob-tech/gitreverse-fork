import { NextRequest, NextResponse } from "next/server";
import { checkActiveSubscriber } from "@/lib/subscriber";

export const runtime = "nodejs";

const MAX_EMAIL_LEN = 320;

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();
  if (!email || email.length > MAX_EMAIL_LEN) {
    return NextResponse.json({ error: "bad_email" }, { status: 400 });
  }

  const subscribed = await checkActiveSubscriber(email);
  if (subscribed === null) {
    return NextResponse.json(
      { subscribed: false, degraded: true },
      { status: 200 }
    );
  }

  return NextResponse.json({ subscribed });
}
