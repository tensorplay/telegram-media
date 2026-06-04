// telegram-media/lib/media-ai-provider.ts
import {
  analyzeMedia as analyzeMediaWithGemini,
  analyzeMediaWithCustomPrompt as analyzeMediaWithGeminiCustomPrompt,
} from "@/lib/gemini";

import {
  analyzeMediaWithTogether,
  analyzeMediaWithTogetherCustomPrompt,
} from "@/lib/together";

import {
  analyzeMediaWithOpenRouter,
  analyzeMediaWithOpenRouterCustomPrompt,
} from "@/lib/openrouter";

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
    normalized.includes("safety") ||
    normalized.includes("content_policy") ||
    normalized.includes("blocked") ||
    normalized.includes("moderation")
  );
}

function isEmptyAnalyzeResult(result: { summary: string; tags: string[] }): boolean {
  return (
    !result.summary?.trim() &&
    (!Array.isArray(result.tags) || result.tags.length === 0)
  );
}

export async function analyzeMedia(
  mediaBytes: Buffer,
  mimeType: string
): Promise<{ summary: string; tags: string[] }> {
  if (!isImage(mimeType)) {
    return analyzeMediaWithGemini(mediaBytes, mimeType);
  }

  try {
    const openRouterResult = await analyzeMediaWithOpenRouter(
      mediaBytes,
      mimeType
    );

    console.log("[media-ai-provider] OpenRouter analyzeMedia result", {
      hasResult: !!openRouterResult,
      summaryLength: openRouterResult?.summary?.length ?? 0,
      tagCount: openRouterResult?.tags?.length ?? 0,
    });

    if (openRouterResult && !isEmptyAnalyzeResult(openRouterResult)) {
      return openRouterResult;
    }
  } catch (error) {
    if (!isFallbackableError(error)) {
      throw error;
    }

    console.warn(
      "[media-ai-provider] OpenRouter analyzeMedia failed, falling back to Gemini",
      error
    );
  }

  try {
    const geminiResult = await analyzeMediaWithGemini(mediaBytes, mimeType);

    console.log("[media-ai-provider] Gemini analyzeMedia result", {
      summaryLength: geminiResult.summary?.length ?? 0,
      tagCount: geminiResult.tags?.length ?? 0,
    });

    if (!isEmptyAnalyzeResult(geminiResult)) {
      return geminiResult;
    }
  } catch (error) {
    if (!isFallbackableError(error)) {
      throw error;
    }

    console.warn(
      "[media-ai-provider] Gemini analyzeMedia failed, falling back to Together",
      error
    );
  }

  const togetherResult = await analyzeMediaWithTogether(mediaBytes, mimeType);

  console.log("[media-ai-provider] Together analyzeMedia result", {
    hasResult: !!togetherResult,
    summaryLength: togetherResult?.summary?.length ?? 0,
    tagCount: togetherResult?.tags?.length ?? 0,
  });

  if (togetherResult) {
    return togetherResult;
  }

  return { summary: "", tags: [] };
}

export async function analyzeMediaWithCustomPrompt(
  mediaBytes: Buffer,
  mimeType: string,
  prompt: string,
  mediaUrl?: string | null
): Promise<unknown> {

  try {
    const openRouterResult = await analyzeMediaWithOpenRouterCustomPrompt(
      mediaBytes,
      mimeType,
      prompt,
      mediaUrl
    );

    console.log("[media-ai-provider] OpenRouter custom prompt result", {
      hasResult: !!openRouterResult,
      length: typeof openRouterResult === "string" ? openRouterResult.length : 0,
    });

    if (typeof openRouterResult === "string" && openRouterResult.trim()) {
      return openRouterResult;
    }
  } catch (error) {
    if (!isFallbackableError(error)) {
      throw error;
    }

    console.warn(
      "[media-ai-provider] OpenRouter custom prompt failed, falling back to Gemini",
      error
    );
  }

  try {
    const geminiResult = await analyzeMediaWithGeminiCustomPrompt(
      mediaBytes,
      mimeType,
      prompt
    );

    console.log("[media-ai-provider] Gemini custom prompt result", {
      hasResult: !!geminiResult,
      length: typeof geminiResult === "string" ? geminiResult.length : 0,
    });

    if (typeof geminiResult !== "string") {
      return geminiResult;
    }

    if (geminiResult.trim()) {
      return geminiResult;
    }
  } catch (error) {
    if (!isFallbackableError(error)) {
      throw error;
    }

    console.warn(
      "[media-ai-provider] Gemini custom prompt failed, falling back to Together",
      error
    );
  }

  if (isImage(mimeType)) {
    const togetherResult = await analyzeMediaWithTogetherCustomPrompt(
      mediaBytes,
      mimeType,
      prompt
    );

    console.log("[media-ai-provider] Together custom prompt result", {
      hasResult: !!togetherResult,
      length: typeof togetherResult === "string" ? togetherResult.length : 0,
    });

    if (togetherResult) {
      return togetherResult;
    }
  }

  return "";
}