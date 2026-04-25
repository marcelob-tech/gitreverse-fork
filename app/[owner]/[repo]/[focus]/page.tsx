import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ReversePromptHome } from "@/components/reverse-prompt-home";
import { focusFingerprint } from "@/lib/focus-fingerprint";
import { isValidGitHubRepoPath, normalizeRepoSegment } from "@/lib/parse-github-repo";
import { getSupabase } from "@/lib/supabase";

type PageProps = {
  params: Promise<{ owner: string; repo: string; focus: string }>;
};

export default async function RepoFocusPage({ params }: PageProps) {
  await connection();
  const { owner: ownerRaw, repo: repoRaw, focus: focusRaw } = await params;
  const owner = decodeURIComponent(ownerRaw);
  const repo = decodeURIComponent(repoRaw);
  let focus: string;
  try {
    focus = decodeURIComponent(focusRaw);
  } catch {
    notFound();
  }

  if (!isValidGitHubRepoPath(owner, repo)) {
    notFound();
  }

  const trimmedFocus = focus.trim();
  if (!trimmedFocus) {
    notFound();
  }

  const repoNorm = normalizeRepoSegment(repo);
  const initialRepoInput = `${owner}/${repoNorm}`;
  const fp = focusFingerprint(trimmedFocus);

  let cachedPrompt: string | undefined;
  try {
    const supabase = getSupabase();
    if (supabase) {
      const { data } = await supabase
        .from("custom_prompt_cache")
        .select("prompt")
        .eq("owner", owner)
        .eq("repo", repoNorm)
        .eq("focus_fingerprint", fp)
        .maybeSingle();
      if (data?.prompt) {
        cachedPrompt = data.prompt as string;
      }
    }
  } catch {
    // fall back to client auto-submit
  }

  return (
    <ReversePromptHome
      initialRepoInput={initialRepoInput}
      autoSubmit={false}
      autoSubmitFocus={cachedPrompt ? undefined : trimmedFocus}
      initialPrompt={cachedPrompt}
      owner={owner}
      repo={repoNorm}
      preserveUrl
      initialGenerationKind={cachedPrompt ? "manual" : undefined}
      initialManualFocus={cachedPrompt ? trimmedFocus : undefined}
    />
  );
}
