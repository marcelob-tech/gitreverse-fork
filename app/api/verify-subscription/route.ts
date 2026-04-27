import { NextRequest, NextResponse } from "next/server";
import { getEmailFromCheckoutSession } from "@/lib/subscriber";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id")?.trim();
  if (!sessionId) {
    return NextResponse.json(
      { error: "missing_session_id" },
      { status: 400 }
    );
  }

  const email = await getEmailFromCheckoutSession(sessionId);
  if (!email) {
    return NextResponse.json({ error: "still_processing" }, { status: 404 });
  }

  return NextResponse.json({ email });
}
