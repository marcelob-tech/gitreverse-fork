"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { ReverseGenerationFlavorText } from "@/components/reverse-generation-flavor-text";
import { HOME_EXAMPLES } from "@/lib/home-example-repos";
import { parseGitHubRepoInput } from "@/lib/parse-github-repo";
import { SUBSCRIBER_EMAIL_HEADER } from "@/lib/subscriber-constants";

const GITREVERSE_HISTORY_KEY = "gitreverse_history";
const GITREVERSE_HISTORY_MAX = 20;
const HISTORY_PROMPT_PREVIEW_LEN = 160;

const RL_KEY_DEEP = "gr_rl_deep";
const RL_KEY_MANUAL = "gr_rl_manual";
const DAILY_CUSTOM_LIMIT = 3;
const SUBSCRIBER_EMAIL_KEY = "gr_subscriber_email";
const PENDING_REDIRECT_KEY = "gr_pending_redirect";

function savePendingRedirect(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PENDING_REDIRECT_KEY, window.location.pathname);
  } catch {
    /* storage unavailable */
  }
}

const PAYMENT_LINK =
  (typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK?.trim()) ||
  "";

type RLEntry = { count: number; date: string };

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getRLEntry(key: string): RLEntry {
  if (typeof window === "undefined")
    return { count: 0, date: getTodayStr() };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { count: 0, date: getTodayStr() };
    const e = JSON.parse(raw) as RLEntry;
    return e.date === getTodayStr() ? e : { count: 0, date: getTodayStr() };
  } catch {
    return { count: 0, date: getTodayStr() };
  }
}

function incrementRLEntry(key: string): void {
  if (typeof window === "undefined") return;
  const e = getRLEntry(key);
  localStorage.setItem(
    key,
    JSON.stringify({ count: e.count + 1, date: e.date })
  );
}

function historyPromptPreview(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= HISTORY_PROMPT_PREVIEW_LEN) return t;
  return `${t.slice(0, HISTORY_PROMPT_PREVIEW_LEN).trimEnd()}…`;
}

/** Stable row id: `quick`, `deep`, or `m:${trimmedFocus}` (manual). */
function historySlotOf(e: { historySlot?: string }): string {
  return e.historySlot ?? "quick";
}

function historySlotFromProps(
  preserveUrl: boolean,
  autoSubmitDeep: boolean,
  autoSubmitFocus: string | undefined,
  initialManualFocus: string | undefined,
  initialGenerationKind: "quick" | "deep" | "manual" | undefined
): string {
  if (preserveUrl) {
    if (autoSubmitDeep || initialGenerationKind === "deep") return "deep";
    const focus =
      (autoSubmitFocus?.trim() || initialManualFocus?.trim()) ?? "";
    if (initialGenerationKind === "manual" || focus) {
      return `m:${focus}`;
    }
  }
  return "quick";
}

function historySlotFromGenerationState(
  kind: "quick" | "deep" | "manual" | null,
  manualFocus: string | null
): string | null {
  if (kind == null) return null;
  if (kind === "deep") return "deep";
  if (kind === "manual") return `m:${manualFocus?.trim() ?? ""}`;
  return "quick";
}

type GitreverseHistoryEntry = {
  owner: string;
  repo: string;
  visitedAt: string;
  /** Distinguishes quick vs deep vs manual rows for the same repo. */
  historySlot?: string;
  promptPreview?: string;
  lastGenerationType?: "quick" | "deep" | "manual";
  lastManualFocus?: string;
};

type ReversePromptHomeProps = {
  initialRepoInput?: string;
  autoSubmit?: boolean;
  initialPrompt?: string;
  owner?: string;
  repo?: string;
  /** Auto-run Deep Reverse on mount (shareable `/owner/repo/deep`). */
  autoSubmitDeep?: boolean;
  /** Auto-run manual control with this focus on mount (shareable `/owner/repo/<focus>`). */
  autoSubmitFocus?: string;
  /** When true, do not rewrite the URL to `/:owner/:repo` after generation. */
  preserveUrl?: boolean;
  /** When SSR provides a cached prompt, record how it was produced for history. */
  initialGenerationKind?: "quick" | "deep" | "manual";
  initialManualFocus?: string;
  isHome?: boolean;
};

export function ReversePromptHome({
  initialRepoInput = "",
  autoSubmit = false,
  initialPrompt,
  owner,
  repo,
  autoSubmitDeep = false,
  autoSubmitFocus,
  preserveUrl = false,
  initialGenerationKind,
  initialManualFocus,
  isHome = false,
}: ReversePromptHomeProps) {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState(initialRepoInput);
  const [customReverse, setCustomReverse] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  /** Hides “Deep Reverse” after a custom or deep run (not needed for that result). */
  const [lastResultWasCustom, setLastResultWasCustom] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [dailyLimitReached, setDailyLimitReached] = useState<
    "deep" | "manual" | null
  >(null);
  const [subscriberEmail, setSubscriberEmail] = useState<string | null>(null);
  const [isSubscriber, setIsSubscriber] = useState(false);
  const [subscriberHydrated, setSubscriberHydrated] = useState(false);
  const [checkoutVerifyState, setCheckoutVerifyState] = useState<
    "idle" | "verifying" | "still_processing"
  >("idle");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [copied, setCopied] = useState(false);
  /** Live line for manual/deep (SSE or cache); empty when idle. */
  const [manualStatusLine, setManualStatusLine] = useState("");
  /**
   * Which request is in flight. Deep Reverse uses `runCustomReverse` without
   * the Manual control checkbox, so we cannot key off `customReverse` alone.
   */
  const [loadKind, setLoadKind] = useState<"none" | "quick" | "custom">("none");
  const [lastGenerationKind, setLastGenerationKind] = useState<
    "quick" | "deep" | "manual" | null
  >(() => initialGenerationKind ?? null);
  const [lastManualFocus, setLastManualFocus] = useState<string | null>(() =>
    initialManualFocus?.trim() ? initialManualFocus.trim() : null
  );
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const autoSubmitStartedRef = useRef(false);

  /** Open Manual control and fill the focus when the URL (or SSR) carries a manual focus segment. */
  useEffect(() => {
    if (autoSubmitDeep) {
      setCustomReverse(false);
      return;
    }
    const focus =
      (autoSubmitFocus?.trim() || initialManualFocus?.trim()) ?? "";
    if (!initialRepoInput?.trim()) {
      if (focus) {
        setCustomReverse(true);
        setCustomPrompt(focus);
      }
      return;
    }
    if (focus) {
      setCustomReverse(true);
      setCustomPrompt(focus);
    } else {
      setCustomReverse(false);
    }
  }, [autoSubmitDeep, autoSubmitFocus, initialManualFocus, initialRepoInput]);

  /** Stripe Payment Link return URL + restore subscriber from localStorage. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    async function hydrateSubscriber() {
      const params = new URLSearchParams(window.location.search);
      const sessionId = params.get("session_id")?.trim();

      if (!sessionId) {
        localStorage.removeItem(PENDING_REDIRECT_KEY);
      }

      if (sessionId) {
        setCheckoutVerifyState("verifying");
        try {
          const res = await fetch(
            `/api/verify-subscription?session_id=${encodeURIComponent(sessionId)}`
          );
          const data = (await res.json()) as { email?: string; error?: string };
          if (cancelled) return;
          if (res.ok && typeof data.email === "string" && data.email) {
            localStorage.setItem(SUBSCRIBER_EMAIL_KEY, data.email);
            setSubscriberEmail(data.email);
            setIsSubscriber(true);
            setDailyLimitReached(null);
            setCheckoutVerifyState("idle");
            const pendingRedirect = localStorage.getItem(PENDING_REDIRECT_KEY);
            localStorage.removeItem(PENDING_REDIRECT_KEY);
            if (pendingRedirect) {
              void router.push(pendingRedirect);
            } else {
              window.history.replaceState(null, "", window.location.pathname);
            }
          } else {
            setCheckoutVerifyState("still_processing");
          }
        } catch {
          if (!cancelled) setCheckoutVerifyState("still_processing");
        }
        if (!cancelled) setSubscriberHydrated(true);
        return;
      }

      const stored = localStorage.getItem(SUBSCRIBER_EMAIL_KEY)?.trim();
      if (stored) {
        try {
          const res = await fetch(
            `/api/check-subscription?email=${encodeURIComponent(stored)}`
          );
          const data = (await res.json()) as { subscribed?: boolean };
          if (cancelled) return;
          if (data.subscribed) {
            setSubscriberEmail(stored);
            setIsSubscriber(true);
          } else {
            localStorage.removeItem(SUBSCRIBER_EMAIL_KEY);
            setSubscriberEmail(null);
            setIsSubscriber(false);
          }
        } catch {
          if (!cancelled) {
            setSubscriberEmail(null);
            setIsSubscriber(false);
          }
        }
      }
      if (!cancelled) setSubscriberHydrated(true);
    }

    void hydrateSubscriber();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const runReversePrompt = useCallback(async (input: string) => {
    setError(null);
    setRateLimited(false);
    setPrompt("");
    setCopied(false);
    setLoadKind("quick");
    setLoading(true);
    try {
      const res = await fetch("/api/reverse-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: input }),
      });
      const data = (await res.json()) as {
        prompt?: string;
        error?: string;
      };
      if (!res.ok) {
        if (res.status === 429) {
          setRateLimited(true);
          return;
        }
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      if (typeof data.prompt === "string") {
        setPrompt(data.prompt);
        setLastResultWasCustom(false);
        setLastGenerationKind("quick");
        setLastManualFocus(null);
        const parsed = parseGitHubRepoInput(input);
        if (parsed && typeof window !== "undefined" && !preserveUrl) {
          window.history.replaceState(
            null,
            "",
            `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
          );
        }
      } else {
        setError("No prompt in response.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
      setLoadKind("none");
    }
  }, [preserveUrl]);

  const runCustomReverse = useCallback(
    async (input: string, focusOrDeep: string | { mode: "deep" }) => {
      setError(null);
      setRateLimited(false);
      setDailyLimitReached(null);
      setPrompt("");
      setCopied(false);
      const isDeep =
        typeof focusOrDeep === "object" && focusOrDeep.mode === "deep";
      const rlKey = isDeep ? RL_KEY_DEEP : RL_KEY_MANUAL;
      const bypassDaily = Boolean(isSubscriber && subscriberEmail?.trim());
      if (
        !bypassDaily &&
        getRLEntry(rlKey).count >= DAILY_CUSTOM_LIMIT
      ) {
        setDailyLimitReached(isDeep ? "deep" : "manual");
        return;
      }
      setManualStatusLine("Checking if it's cached…");
      setLoadKind("custom");
      setLoading(true);
      try {
        const bodyObj = isDeep
          ? { repoUrl: input, mode: "deep" as const, stream: true as const }
          : {
              repoUrl: input,
              customPrompt: focusOrDeep as string,
              stream: true as const,
            };

        const res = await fetch("/api/custom-reverse", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(subscriberEmail
              ? { [SUBSCRIBER_EMAIL_HEADER]: subscriberEmail }
              : {}),
          },
          body: JSON.stringify(bodyObj),
        });

        const ct = res.headers.get("content-type") ?? "";

        if (ct.includes("application/json")) {
          const data = (await res.json()) as {
            prompt?: string;
            error?: string;
            fromCache?: boolean;
          };
          if (!res.ok) {
            if (res.status === 429) {
              if (data.error === "daily_limit_reached") {
                if (typeof window !== "undefined") {
                  localStorage.setItem(
                    rlKey,
                    JSON.stringify({
                      count: DAILY_CUSTOM_LIMIT,
                      date: getTodayStr(),
                    })
                  );
                }
                setDailyLimitReached(isDeep ? "deep" : "manual");
              } else {
                setRateLimited(true);
              }
              return;
            }
            setError(data.error ?? `Request failed (${res.status})`);
            return;
          }
          if (typeof data.prompt === "string") {
            if (data.fromCache) {
              setManualStatusLine("Loaded from cache");
              await new Promise((r) => setTimeout(r, 450));
            } else if (typeof window !== "undefined" && !bypassDaily) {
              incrementRLEntry(rlKey);
            }
            setPrompt(data.prompt);
            setLastResultWasCustom(true);
            if (isDeep) {
              setLastGenerationKind("deep");
              setLastManualFocus(null);
            } else {
              setLastGenerationKind("manual");
              setLastManualFocus(String(focusOrDeep as string).trim());
            }
            const parsed = parseGitHubRepoInput(input);
            if (parsed && typeof window !== "undefined" && !preserveUrl) {
              window.history.replaceState(
                null,
                "",
                `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
              );
            }
          } else {
            setError("No prompt in response.");
          }
          return;
        }

        if (!res.ok) {
          try {
            const errData = (await res.json()) as { error?: string };
            if (res.status === 429) {
              if (errData.error === "daily_limit_reached") {
                if (typeof window !== "undefined") {
                  localStorage.setItem(
                    rlKey,
                    JSON.stringify({
                      count: DAILY_CUSTOM_LIMIT,
                      date: getTodayStr(),
                    })
                  );
                }
                setDailyLimitReached(isDeep ? "deep" : "manual");
              } else {
                setRateLimited(true);
              }
            } else {
              setError(errData.error ?? `Request failed (${res.status})`);
            }
          } catch {
            if (res.status === 429) {
              setRateLimited(true);
            } else {
              setError(`Request failed (${res.status})`);
            }
          }
          return;
        }

        if (!res.body) {
          setError("No response body from manual control.");
          return;
        }

        if (typeof window !== "undefined" && !bypassDaily) {
          incrementRLEntry(rlKey);
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          for (;;) {
            const idx = buffer.indexOf("\n\n");
            if (idx < 0) break;
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = "message";
            let dataStr = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) {
                event = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataStr = line.slice(5).trim();
              }
            }
            if (!dataStr) continue;
            try {
              if (event === "status") {
                const j = JSON.parse(dataStr) as { message?: string };
                if (typeof j.message === "string" && j.message) {
                  setManualStatusLine(j.message);
                }
              } else if (event === "done") {
                const j = JSON.parse(dataStr) as { prompt?: string };
                if (typeof j.prompt === "string") {
                  setPrompt(j.prompt);
                  setLastResultWasCustom(true);
                  if (isDeep) {
                    setLastGenerationKind("deep");
                    setLastManualFocus(null);
                  } else {
                    setLastGenerationKind("manual");
                    setLastManualFocus(String(focusOrDeep as string).trim());
                  }
                  const parsed = parseGitHubRepoInput(input);
                  if (parsed && typeof window !== "undefined" && !preserveUrl) {
                    window.history.replaceState(
                      null,
                      "",
                      `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
                    );
                  }
                } else {
                  setError("No prompt in response.");
                }
              } else if (event === "error") {
                const j = JSON.parse(dataStr) as { error?: string };
                setError(j.error ?? "Request failed");
              }
            } catch {
              // ignore malformed SSE chunk
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setLoading(false);
        setLoadKind("none");
        setManualStatusLine("");
      }
    },
    [preserveUrl, isSubscriber, subscriberEmail]
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const trimmed = repoUrl.trim();

    if (!initialRepoInput?.trim()) {
      const parsed = parseGitHubRepoInput(trimmed);
      if (!parsed) return;
      if (customReverse) {
        const focus = customPrompt.trim();
        void router.push(
          focus
            ? `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${encodeURIComponent(focus)}`
            : `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
        );
      } else {
        void router.push(
          `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
        );
      }
      return;
    }

    if (customReverse) {
      void runCustomReverse(trimmed, customPrompt.trim());
    } else {
      void runReversePrompt(trimmed);
    }
  }

  function onCustomReverseCheckboxChange(wantsOn: boolean) {
    setCustomReverse(wantsOn);
  }

  useEffect(() => {
    if (!subscriberHydrated) return;
    if (autoSubmitStartedRef.current) return;
    const trimmed = initialRepoInput?.trim() ?? "";
    if (!trimmed || !parseGitHubRepoInput(trimmed)) return;

    if (autoSubmitDeep) {
      autoSubmitStartedRef.current = true;
      void runCustomReverse(trimmed, { mode: "deep" });
      return;
    }
    const focus = autoSubmitFocus?.trim() ?? "";
    if (focus) {
      autoSubmitStartedRef.current = true;
      void runCustomReverse(trimmed, focus);
      return;
    }
    if (autoSubmit) {
      autoSubmitStartedRef.current = true;
      void runReversePrompt(trimmed);
    }
  }, [
    subscriberHydrated,
    autoSubmit,
    autoSubmitDeep,
    autoSubmitFocus,
    initialRepoInput,
    runCustomReverse,
    runReversePrompt,
  ]);

  /* `/owner/repo` uses quick auto-submit; `/owner/repo/deep` and `/owner/repo/<focus>` use the branches above. */

  useEffect(() => {
    if (typeof window === "undefined") return;
    const o = owner?.trim();
    const r = repo?.trim();
    if (!o || !r) return;

    /* Server-side dedupes by IP hash, so we no longer need a localStorage gate. */
    void fetch("/api/increment-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: o, repo: r }),
    }).catch(() => {
      /* swallow — view counter is best-effort */
    });
  }, [owner, repo]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const o = owner?.trim();
    const r = repo?.trim();
    const p = prompt.trim();
    if (!o || !r || !p) return;

    const preview = historyPromptPreview(p);
    const raw = localStorage.getItem(GITREVERSE_HISTORY_KEY);
    let arr: GitreverseHistoryEntry[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        arr = Array.isArray(parsed) ? (parsed as GitreverseHistoryEntry[]) : [];
      } catch {
        return;
      }
    }
    const slot =
      historySlotFromGenerationState(lastGenerationKind, lastManualFocus) ??
      historySlotFromProps(
        preserveUrl,
        autoSubmitDeep,
        autoSubmitFocus,
        initialManualFocus,
        initialGenerationKind
      );

    const idx = arr.findIndex(
      (e) => e.owner === o && e.repo === r && historySlotOf(e) === slot
    );

    const gen = lastGenerationKind ?? undefined;
    const focusMeta =
      lastGenerationKind === "manual" && lastManualFocus?.trim()
        ? lastManualFocus.trim()
        : undefined;

    if (idx === -1) {
      arr.unshift({
        owner: o,
        repo: r,
        historySlot: slot,
        visitedAt: new Date().toISOString(),
        promptPreview: preview,
        ...(gen != null ? { lastGenerationType: gen } : {}),
        lastManualFocus: focusMeta,
      });
      localStorage.setItem(
        GITREVERSE_HISTORY_KEY,
        JSON.stringify(arr.slice(0, GITREVERSE_HISTORY_MAX))
      );
      return;
    }

    const cur = arr[idx];
    const samePreview = cur.promptPreview === preview;
    const sameGen = cur.lastGenerationType === gen;
    const sameFocus = cur.lastManualFocus === focusMeta;
    if (samePreview && sameGen && sameFocus) return;

    arr[idx] = {
      ...cur,
      historySlot: slot,
      promptPreview: preview,
      ...(gen != null ? { lastGenerationType: gen } : {}),
      lastManualFocus: focusMeta,
    };
    localStorage.setItem(GITREVERSE_HISTORY_KEY, JSON.stringify(arr));
  }, [
    owner,
    repo,
    prompt,
    lastGenerationKind,
    lastManualFocus,
    preserveUrl,
    autoSubmitDeep,
    autoSubmitFocus,
    initialManualFocus,
    initialGenerationKind,
  ]);

  useEffect(() => {
    if (!prompt) return;
    const id = requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
    return () => cancelAnimationFrame(id);
  }, [prompt]);

  const reverseEngineeredRepo = useMemo(
    () => (prompt ? parseGitHubRepoInput(repoUrl) : null),
    [prompt, repoUrl]
  );

  async function copyPrompt() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#FFFDF8] text-zinc-900">
      <nav className="sticky top-0 z-50 border-b-[3px] border-zinc-900 bg-[#FFFDF8]">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="text-xl font-bold tracking-tight transition-transform hover:-translate-y-0.5"
            aria-label="GitReverse home"
          >
            <span className="text-zinc-900">Git</span>
            <span className="text-[#d31611]">Reverse</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/library"
              className="font-semibold text-zinc-900 transition-transform hover:-translate-y-0.5"
            >
              Library
            </Link>
            <Link
              href="/history"
              className="font-semibold text-zinc-900 transition-transform hover:-translate-y-0.5"
            >
              History
            </Link>
            <a
              href="https://github.com/filiksyos/gitreverse"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-zinc-900 transition-transform hover:-translate-y-0.5"
            >
              GitHub
            </a>
          </div>
        </div>
      </nav>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center gap-12 px-4 py-12 sm:px-6">
        {checkoutVerifyState === "verifying" ? (
          <div
            className="w-full max-w-2xl rounded-lg border-[3px] border-zinc-400 bg-zinc-50 p-4 text-center text-sm text-zinc-800"
            role="status"
            aria-live="polite"
          >
            Confirming your subscription…
          </div>
        ) : null}
        {checkoutVerifyState === "still_processing" ? (
          <div
            className="w-full max-w-2xl rounded-lg border-[3px] border-amber-400 bg-amber-50 p-4"
            role="alert"
          >
            <p className="text-sm font-semibold text-amber-900">
              Payment is still syncing
            </p>
            <p className="mt-2 text-sm text-amber-800">
              Wait a few seconds and retry — we pull your email from Stripe as
              soon as it lands in the database.
            </p>
            <button
              type="button"
              onClick={async () => {
                const sid = new URLSearchParams(window.location.search)
                  .get("session_id")
                  ?.trim();
                if (!sid) return;
                setCheckoutVerifyState("verifying");
                try {
                  const res = await fetch(
                    `/api/verify-subscription?session_id=${encodeURIComponent(sid)}`
                  );
                  const data = (await res.json()) as { email?: string };
                  if (res.ok && typeof data.email === "string" && data.email) {
                    localStorage.setItem(SUBSCRIBER_EMAIL_KEY, data.email);
                    setSubscriberEmail(data.email);
                    setIsSubscriber(true);
                    setDailyLimitReached(null);
                    setCheckoutVerifyState("idle");
                    const pendingRedirect = localStorage.getItem(
                      PENDING_REDIRECT_KEY
                    );
                    localStorage.removeItem(PENDING_REDIRECT_KEY);
                    if (pendingRedirect) {
                      void router.push(pendingRedirect);
                    } else {
                      window.history.replaceState(
                        null,
                        "",
                        window.location.pathname
                      );
                    }
                  } else {
                    setCheckoutVerifyState("still_processing");
                  }
                } catch {
                  setCheckoutVerifyState("still_processing");
                }
              }}
              className="mt-3 rounded border-[2px] border-amber-700 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100"
            >
              Retry
            </button>
          </div>
        ) : null}
        <div className="flex w-full flex-col items-center gap-6">
          {isHome && (
            <div className="relative flex w-full flex-col items-center text-center">
              <svg
                className="absolute left-0 top-0 hidden h-16 w-16 sm:block lg:left-8"
                viewBox="0 0 91 98"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="m35.878 14.162 1.333-5.369 1.933 5.183c4.47 11.982 14.036 21.085 25.828 24.467l5.42 1.555-5.209 2.16c-11.332 4.697-19.806 14.826-22.888 27.237l-1.333 5.369-1.933-5.183C34.56 57.599 24.993 48.496 13.201 45.114l-5.42-1.555 5.21-2.16c11.331-4.697 19.805-14.826 22.887-27.237Z"
                  fill="#FE4A60"
                  stroke="#000"
                  strokeWidth="3.445"
                />
                <path
                  d="M79.653 5.729c-2.436 5.323-9.515 15.25-18.341 12.374m9.197 16.336c2.6-5.851 10.008-16.834 18.842-13.956m-9.738-15.07c-.374 3.787 1.076 12.078 9.869 14.943M70.61 34.6c.503-4.21-.69-13.346-9.49-16.214M14.922 65.967c1.338 5.677 6.372 16.756 15.808 15.659M18.21 95.832c-1.392-6.226-6.54-18.404-15.984-17.305m12.85-12.892c-.41 3.771-3.576 11.588-12.968 12.681M18.025 96c.367-4.21 3.453-12.905 12.854-14"
                  stroke="#000"
                  strokeWidth="2.548"
                  strokeLinecap="round"
                />
              </svg>
              <svg
                className="absolute right-0 top-4 hidden h-14 w-14 sm:block lg:right-8"
                viewBox="0 0 92 80"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="m35.213 16.953.595-5.261 2.644 4.587a35.056 35.056 0 0 0 26.432 17.33l5.261.594-4.587 2.644A35.056 35.056 0 0 0 48.23 63.28l-.595 5.26-2.644-4.587a35.056 35.056 0 0 0-26.432-17.328l-5.261-.595 4.587-2.644a35.056 35.056 0 0 0 17.329-26.433Z"
                  fill="#5CF1A4"
                  stroke="#000"
                  strokeWidth="2.868"
                />
                <path
                  d="M75.062 40.108c1.07 5.255 1.072 16.52-7.472 19.54m7.422-19.682c1.836 2.965 7.643 8.14 16.187 5.121-8.544 3.02-8.207 15.23-6.971 20.957-1.97-3.343-8.044-9.274-16.588-6.254M12.054 28.012c1.34-5.22 6.126-15.4 14.554-14.369M12.035 28.162c-.274-3.487-2.93-10.719-11.358-11.75C9.104 17.443 14.013 6.262 15.414.542c.226 3.888 2.784 11.92 11.212 12.95"
                  stroke="#000"
                  strokeWidth="2.319"
                  strokeLinecap="round"
                />
              </svg>
              <h1 className="text-5xl font-extrabold tracking-tighter sm:text-6xl lg:text-7xl">
                Repository to
                <br />
                Prompt
              </h1>
              <p className="mt-4 max-w-xl text-lg text-zinc-600">
                Reverse engineer a codebase into a prompt that likely created it.
              </p>
            </div>
          )}
          <div className="flex w-full max-w-2xl flex-col gap-3">
          <div className="relative w-full">
            <div className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl bg-zinc-900" />
            <form
              onSubmit={onSubmit}
              className="relative z-10 rounded-xl border-[3px] border-zinc-900 bg-[#fff4da] p-6"
            >
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
                  <div className="relative min-w-0 flex-1">
                    <div className="absolute inset-0 translate-x-1 translate-y-1 rounded bg-zinc-900" />
                    <input
                      name="repoUrl"
                      autoComplete="off"
                      className="relative z-10 w-full rounded border-[3px] border-zinc-900 bg-white px-4 py-3 text-base text-zinc-900 placeholder-zinc-500 focus:outline-none"
                      placeholder="https://github.com/…"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div className="group relative w-full shrink-0 sm:w-auto">
                    <div className="absolute inset-0 translate-x-1 translate-y-1 rounded bg-zinc-800" />
                    <button
                      type="submit"
                      disabled={loading}
                      aria-busy={loading}
                      className={`relative z-10 flex w-full items-center justify-center gap-2 rounded border-[3px] border-zinc-900 px-6 py-3 font-medium text-white transition-transform group-hover:-translate-x-px group-hover:-translate-y-px disabled:pointer-events-none sm:min-w-[10rem] ${
                        loading ? "bg-[#b5120e]" : "bg-[#d31611]"
                      }`}
                    >
                      {loading ? (
                        <>
                          <svg
                            className="h-5 w-5 shrink-0 animate-spin text-white"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            aria-hidden
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                          <span>Processing…</span>
                        </>
                      ) : (
                        "Get Prompt"
                      )}
                    </button>
                  </div>
                </div>
                <div className="flex w-full flex-col gap-2">
                  <label
                    className={`flex items-center gap-2 text-sm font-medium ${
                      loading
                        ? "cursor-not-allowed text-zinc-500"
                        : "cursor-pointer text-zinc-800"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-[2px] border-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                      checked={customReverse}
                      disabled={loading}
                      onChange={(e) =>
                        onCustomReverseCheckboxChange(e.target.checked)
                      }
                    />
                    Manual control
                  </label>
                  {customReverse ? (
                    <div className="relative w-full">
                      <div className="absolute inset-0 translate-x-1 translate-y-1 rounded bg-zinc-900" />
                      <textarea
                        name="customPrompt"
                        rows={4}
                        className="relative z-10 w-full resize-y rounded border-[3px] border-zinc-900 bg-white px-4 py-3 text-base text-zinc-900 placeholder-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-80"
                        placeholder="repurpose into your own version, or focus on a specific feature"
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        required={customReverse}
                        disabled={loading}
                      />
                    </div>
                  ) : null}
                </div>
              </div>

              {loading ? (
                <div className="mt-4">
                  {loadKind === "custom" ? (
                    <p
                      className="min-h-[1.25rem] text-sm text-zinc-600"
                      role="status"
                      aria-live="polite"
                    >
                      {manualStatusLine}
                    </p>
                  ) : (
                    <ReverseGenerationFlavorText />
                  )}
                </div>
              ) : null}

              {dailyLimitReached ? (
                <div
                  className="mt-4 rounded-lg border-[3px] border-zinc-400 bg-zinc-100 p-4"
                  role="alert"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                    <p className="text-sm font-semibold text-zinc-900">
                      You&apos;ve hit today&apos;s limit.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {PAYMENT_LINK ? (
                        <button
                          type="button"
                          onClick={() => {
                            savePendingRedirect();
                            window.location.href = PAYMENT_LINK;
                          }}
                          className="inline-flex items-center justify-center rounded border-[2px] border-zinc-900 bg-[#ffc480] px-3 py-1.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-[#ffbd5c]"
                        >
                          Get Unlimited
                        </button>
                      ) : null}
                      <Link
                        href="/library"
                        className={`inline-flex items-center justify-center rounded border-[2px] px-3 py-1.5 text-sm font-semibold transition-colors ${
                          PAYMENT_LINK
                            ? "border-zinc-400 bg-white text-zinc-800 hover:bg-zinc-50"
                            : "border-zinc-800 bg-white text-zinc-900 hover:bg-zinc-50"
                        }`}
                      >
                        Browse Library
                      </Link>
                    </div>
                  </div>
                </div>
              ) : rateLimited ? (
                <div className="mt-4 rounded-lg border-[3px] border-amber-400 bg-amber-50 p-4" role="alert">
                  <p className="font-semibold text-amber-900">Sorry, we&apos;re a bit overwhelmed right now.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <p className="w-full text-sm text-amber-800">Come back in a couple of hours, or check out what others have already generated:</p>
                    <Link
                      href="/library"
                      className="inline-flex items-center justify-center rounded border-[2px] border-amber-600 bg-amber-100 px-3 py-1.5 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-200"
                    >
                      Browse the library
                    </Link>
                  </div>
                </div>
              ) : error ? (
                <p className="mt-3 text-sm text-red-600" role="alert">
                  {error}
                </p>
              ) : null}
              {isHome && !loading && !customReverse ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="w-full text-sm text-zinc-600">
                    Try example repos:
                  </span>
                  {HOME_EXAMPLES.map(({ label, url }) => (
                    <div key={url} className="group relative">
                      <div className="absolute inset-0 translate-x-0.5 translate-y-0.5 rounded bg-zinc-900" />
                      <button
                        type="button"
                        onClick={() => setRepoUrl(url)}
                        className="relative z-10 rounded border-[3px] border-zinc-900 bg-[#EBDBB7] px-3 py-1 text-sm font-medium text-zinc-900 transition-transform hover:bg-[#ffc480] group-hover:-translate-x-px group-hover:-translate-y-px"
                      >
                        {label}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </form>
          </div>
          {isHome && (
            <p className="text-center text-sm text-zinc-500">
              You can also replace{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-700">
                hub
              </code>{" "}
              with{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-700">
                reverse
              </code>{" "}
              in any GitHub URL.
            </p>
          )}
          </div>
        </div>

        {prompt ? (
          <div
            ref={resultsRef}
            data-results
            className="relative w-full max-w-2xl scroll-mt-24"
          >
            <div className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl bg-zinc-900" />
            <section className="relative z-10 rounded-xl border-[3px] border-zinc-900 bg-[#fafafa] p-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-zinc-700">
                  Reverse engineered prompt
                </h2>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {reverseEngineeredRepo ? (
                    <a
                      href={`https://github.com/${encodeURIComponent(reverseEngineeredRepo.owner)}/${encodeURIComponent(reverseEngineeredRepo.repo)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`View ${reverseEngineeredRepo.owner}/${reverseEngineeredRepo.repo} on GitHub`}
                      className="group/gh relative inline-flex rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2"
                    >
                      <span className="absolute inset-0 translate-x-0.5 translate-y-0.5 rounded bg-zinc-900 transition-transform group-hover/gh:translate-x-px group-hover/gh:translate-y-px" />
                      <span className="relative z-10 inline-flex items-center gap-1.5 rounded border-[3px] border-zinc-900 bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-900 transition-colors group-hover/gh:bg-zinc-50">
                        <svg
                          className="h-3.5 w-3.5 shrink-0"
                          viewBox="0 0 98 96"
                          xmlns="http://www.w3.org/2000/svg"
                          aria-hidden="true"
                        >
                          <path
                            fillRule="evenodd"
                            clipRule="evenodd"
                            d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.096-.08-9.211-13.588 2.963-16.424-5.867-16.424-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.613-10.839-1.22-22.229-5.412-22.229-24.054 0-5.312 1.895-9.718 5.424-13.126-.526-1.324-2.356-6.74.505-14.052 0 0 4.432-1.505 14.5 5.008 4.172-1.095 8.73-1.63 13.168-1.656 4.469.026 8.971.561 13.166 1.656 10.06-6.513 14.48-5.008 14.48-5.008 2.866 7.326 1.052 12.728.53 14.052 3.532 3.408 5.414 7.814 5.414 13.126 0 18.728-11.401 22.813-22.285 23.985 1.772 1.514 3.316 4.539 3.316 9.119 0 6.613-.08 11.898-.08 13.526 0 1.304.878 2.853 3.316 2.364C84.974 89.385 98 70.983 98 49.204 98 22 76.038 0 48.854 0z"
                            fill="currentColor"
                          />
                        </svg>
                        GitHub
                      </span>
                    </a>
                  ) : null}
                  <div className="group relative">
                    <div className="absolute inset-0 translate-x-0.5 translate-y-0.5 rounded bg-zinc-900" />
                    <button
                      type="button"
                      onClick={copyPrompt}
                      className="relative z-10 rounded border-[3px] border-zinc-900 bg-[#ffc480] px-3 py-1.5 text-xs font-medium text-zinc-900 transition-transform group-hover:-translate-x-px group-hover:-translate-y-px"
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="max-h-[min(70vh,32rem)] overflow-auto rounded-lg border border-zinc-200 bg-white p-4 text-sm leading-relaxed text-zinc-800">
                <ReactMarkdown
                  components={{
                    h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-bold first:mt-0">{children}</h1>,
                    h2: ({ children }) => <h2 className="mb-2 mt-4 text-sm font-bold first:mt-0">{children}</h2>,
                    h3: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                    ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
                    ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                    em: ({ children }) => <em className="italic">{children}</em>,
                    code: ({ children }) => <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs">{children}</code>,
                    pre: ({ children }) => <pre className="mb-2 overflow-auto rounded bg-zinc-100 p-3 font-mono text-xs">{children}</pre>,
                    hr: () => <hr className="my-3 border-zinc-200" />,
                    blockquote: ({ children }) => <blockquote className="border-l-2 border-zinc-300 pl-3 text-zinc-600">{children}</blockquote>,
                  }}
                >
                  {prompt}
                </ReactMarkdown>
              </div>
              {!lastResultWasCustom && !loading ? (
                <p className="mt-4 text-center text-sm text-zinc-600">
                  Want more depth?{" "}
                  <span
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer font-medium text-zinc-900 underline decoration-zinc-400 underline-offset-2 transition-colors hover:text-zinc-950"
                    onClick={() => {
                      const parsed = parseGitHubRepoInput(repoUrl.trim());
                      if (!initialRepoInput?.trim() && parsed) {
                        void router.push(
                          `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/deep`
                        );
                      } else {
                        void runCustomReverse(repoUrl.trim(), { mode: "deep" });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      const parsed = parseGitHubRepoInput(repoUrl.trim());
                      if (!initialRepoInput?.trim() && parsed) {
                        void router.push(
                          `/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/deep`
                        );
                      } else {
                        void runCustomReverse(repoUrl.trim(), { mode: "deep" });
                      }
                    }}
                  >
                    Deep Reverse
                  </span>
                </p>
              ) : null}
            </section>
          </div>
        ) : null}
      </main>

      <footer className="border-t border-zinc-200 py-6 text-center text-sm text-zinc-500">
        <div className="mx-auto flex max-w-4xl justify-center px-4 sm:px-6">
          <a
            href="https://discord.gg/Uq7fTGsQX"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-zinc-700 underline decoration-zinc-400 underline-offset-2 transition-colors hover:text-zinc-900"
          >
            <svg
              className="h-4 w-4 shrink-0"
              viewBox="0 0 24 24"
              fill="currentColor"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
            Discord
          </a>
        </div>
      </footer>
    </div>
  );
}
