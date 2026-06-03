import {
  analyzeMedia as analyzeMediaWithGemini,
  analyzeMediaWithCustomPrompt as analyzeMediaWithGeminiCustomPrompt,
} from "@/lib/gemini";

import {
  analyzeMediaWithTogether,
  analyzeMediaWithTogetherCustomPrompt,
} from "@/lib/together";

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isFallbackableError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : JSON.stringify(error);

  const normalized = message.toLowerCase();

  return (
    normalized.includes("permission_denied") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("quota") ||
    normalized.includes("billing") ||
    normalized.includes("dunning") ||
    normalized.includes("rate limit") ||
    normalized.includes("safety")
  );
}

export async function analyzeMedia(
  mediaBytes: Buffer,
  mimeType: string
): Promise<{ summary: string; tags: string[] }> {
  try {
    const result = await analyzeMediaWithGemini(mediaBytes, mimeType);

    if (
      isImage(mimeType) &&
      !result.summary?.trim() &&
      (!Array.isArray(result.tags) || result.tags.length === 0)
    ) {
      const fallback = await analyzeMediaWithTogether(mediaBytes, mimeType);
      console.log("[media-ai-provider] Together analyzeMedia result", {
        hasFallback: !!fallback,
        summaryLength: fallback?.summary?.length ?? 0,
        tagCount: fallback?.tags?.length ?? 0,
      });      
      if (fallback) return fallback;
    }

    return result;
  } catch (error) {
    if (!isImage(mimeType) || !isFallbackableError(error)) {
      throw error;
    }

    console.warn(
      "[media-ai-provider] Gemini analyzeMedia failed, falling back to Together",
      error
    );

    const fallback = await analyzeMediaWithTogether(mediaBytes, mimeType);

    console.log("[media-ai-provider] Together analyzeMedia result", {
      hasFallback: !!fallback,
      summaryLength: fallback?.summary?.length ?? 0,
      tagCount: fallback?.tags?.length ?? 0,
    });

    if (!fallback) {
      throw error;
    }

    return fallback;
  }
}

export async function analyzeMediaWithCustomPrompt(
  mediaBytes: Buffer,
  mimeType: string,
  prompt: string
): Promise<unknown> {
  try {
    const result = await analyzeMediaWithGeminiCustomPrompt(
      mediaBytes,
      mimeType,
      prompt
    );

    if (isImage(mimeType) && typeof result === "string" && !result.trim()) {
      const fallback = await analyzeMediaWithTogetherCustomPrompt(
        mediaBytes,
        mimeType,
        prompt
      );
      console.log("[media-ai-provider] Together custom prompt result", {
        hasFallback: !!fallback,
        length: typeof fallback === "string" ? fallback.length : 0,
      });
      if (fallback) return fallback;
    }

    return result;
  } catch (error) {
    if (!isImage(mimeType) || !isFallbackableError(error)) {
      throw error;
    }

    console.warn(
      "[media-ai-provider] Gemini custom prompt failed, falling back to Together",
      error
    );

    const fallback = await analyzeMediaWithTogetherCustomPrompt(
      mediaBytes,
      mimeType,
      prompt
    );

    console.log("[media-ai-provider] Together custom prompt result", {
      hasFallback: !!fallback,
      length: typeof fallback === "string" ? fallback.length : 0,
    });    

    if (!fallback) {
      throw error;
    }

    return fallback;
  }
}