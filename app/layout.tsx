import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GitReverse",
  description:
    "Turn a GitHub repository into a plain-language coding agent prompt.",
};

const checkoutNavigationRestoreScript = `
(function () {
  var key = "gr_checkout_navigation_state";
  var reloading = false;

  function getState() {
    try {
      return sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function setState(value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (_) {}
  }

  function clearState() {
    try {
      sessionStorage.removeItem(key);
    } catch (_) {}
  }

  function maybeReload() {
    if (reloading) return;
    var state = getState();
    if (state !== "started" && state !== "left") return;
    if (new URLSearchParams(window.location.search).get("session_id")) {
      clearState();
      return;
    }
    reloading = true;
    setState("returned");
    window.location.reload();
  }

  function markLeft() {
    if (getState() === "started") {
      setState("left");
    }
  }

  window.addEventListener("pagehide", markLeft);
  window.addEventListener("pageshow", maybeReload);
  window.addEventListener("focus", maybeReload);
  window.addEventListener("popstate", maybeReload);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      markLeft();
    } else {
      maybeReload();
    }
  });
  maybeReload();
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full bg-[#fffdf8] antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <script
          dangerouslySetInnerHTML={{ __html: checkoutNavigationRestoreScript }}
        />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
