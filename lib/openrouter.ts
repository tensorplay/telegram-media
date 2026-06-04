// telegram-media/lib/openrouter.ts
/**
 * OpenRouter vision client used as a fallback when Gemini's hard safety filter
 * refuses to analyze explicit content.
 *
 * Images are sent inline as base64 data URLs.
 *
 * Videos require a public or signed URL because sending large videos inline as
 * base64 JSON is not practical. The caller should pass an R2 signed URL when
 * available.
 */

const OPENROUTER_VISION_MODEL =
  process.env.OPENROUTER_VISION_MODEL ?? "google/gemini-2.5-flash"; //"qwen/qwen3.6-flash"; //"qwen/qwen3.5-flash-02-23"; //"qwen/qwen3.6-flash";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

function getApiKey(): string | null {
  return process.env.OPENROUTER_API_KEY || null;
}

function toDataUrl(mediaBytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${mediaBytes.toString("base64")}`;
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

async function callOpenRouterVision(
  mediaBytes: Buffer,
  mimeType: string,
  prompt: string,
  mediaUrl?: string | null
): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");

  if (!isImage && !isVideo) {
    return null;
  }


  console.log("[openrouter.vision] input", {
    model: OPENROUTER_VISION_MODEL,
    mimeType,
    isImage,
    isVideo,
    mediaBytesLength: mediaBytes.length,
    promptLength: prompt.length,
    hasMediaUrl: Boolean(mediaUrl),
    mediaUrl: mediaUrl ? mediaUrl : null,    
    mediaUrlLength: mediaUrl?.length ?? 0,
    mediaUrlHasQuery: Boolean(mediaUrl?.includes("?")),
    mediaUrlPreviewStart: mediaUrl ? mediaUrl.slice(0, 160) : null,
    mediaUrlPreviewEnd: mediaUrl ? mediaUrl.slice(-300) : null,
  });  

  if (isVideo && !mediaUrl) {
    console.warn("[openrouter.vision] skipped video because mediaUrl is missing");
    return null;
  }

  const mediaPart = isImage
    ? {
        type: "image_url",
        image_url: {
          url: toDataUrl(mediaBytes, mimeType),
        },
      }
    : {
        type: "video_url",
        video_url: {
          url: mediaUrl!,
        },
      };

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,

      // Optional but recommended by OpenRouter.
      ...(process.env.OPENROUTER_SITE_URL
        ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL }
        : {}),
      ...(process.env.OPENROUTER_APP_NAME
        ? { "X-Title": process.env.OPENROUTER_APP_NAME }
        : {}),
    },
    body: JSON.stringify({
      model: OPENROUTER_VISION_MODEL,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            mediaPart,
          ],
        },
      ],
    }),
  });

  console.log("[openrouter.vision] response", {
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter API error: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText.slice(0, 1000)}` : ""
      }`
    );
  }

  const rawText = await response.text();

  console.log("[openrouter.vision] raw response text", {
    length: rawText.length,
    preview: rawText.slice(0, 5000),
  });

  let json: any = null;

  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    console.error("[openrouter.vision] failed to parse JSON response", {
      error,
      rawTextPreview: rawText.slice(0, 5000),
    });

    return null;
  }

  console.log("[openrouter.vision] raw json preview", {
    topLevelKeys: json && typeof json === "object" ? Object.keys(json) : null,
    error: json?.error ?? null,
    id: json?.id ?? null,
    model: json?.model ?? null,
    provider: json?.provider ?? null,
    choicesLength: Array.isArray(json?.choices) ? json.choices.length : 0,
    finishReason: json?.choices?.[0]?.finish_reason ?? null,
    messageKeys:
      json?.choices?.[0]?.message && typeof json.choices[0].message === "object"
        ? Object.keys(json.choices[0].message)
        : null,
    contentPreview:
      typeof json?.choices?.[0]?.message?.content === "string"
        ? json.choices[0].message.content.slice(0, 1000)
        : JSON.stringify(json?.choices?.[0]?.message?.content ?? null).slice(0, 1000),
  });

  if (json?.error) {
    throw new Error(
      `OpenRouter provider error: ${JSON.stringify(json.error).slice(0, 1000)}`
    );
  }

  if (!Array.isArray(json?.choices) || json.choices.length === 0) {
    throw new Error(
      `OpenRouter returned no choices: ${rawText.slice(0, 1000)}`
    );
  }

  const content = json?.choices?.[0]?.message?.content;
  const extractedText = extractTextFromMessageContent(content);

  console.log("[openrouter.vision] extracted text", {
    length: extractedText.length,
    preview: extractedText.slice(0, 1000),
  });

  return extractedText;
}

/**
 * Mirror of `analyzeMedia`: returns a JSON-parsed `{ summary, tags }`.
 *
 * For videos, `mediaUrl` is required.
 */
export async function analyzeMediaWithOpenRouter(
  mediaBytes: Buffer,
  mimeType: string,
  mediaUrl?: string | null
): Promise<{ summary: string; tags: string[] } | null> {
  const prompt = `Analyze this media and return a JSON object with exactly two fields:
1. "summary": A concise 1-2 sentence description of the content.
2. "tags": An array of 5-15 lowercase tags useful for sorting creator content. Include tags for: setting/location, clothing/outfit (or state of undress), mood/vibe, pose/activity, colors, time of day, indoor/outdoor, and any notable elements. Be factually descriptive of what is shown — this is an adult content library, so tags about nudity, lingerie, or explicit acts are expected and useful when applicable.

Return ONLY the raw JSON object, no markdown fences or extra text.`;

  let text: string | null;

  try {
    text = await callOpenRouterVision(mediaBytes, mimeType, prompt, mediaUrl);
  } catch (error) {
    console.error("[openrouter.analyzeMedia] OpenRouter API call failed:", error);
    return null;
  }

  if (!text) return null;

  try {
    const parsed = JSON.parse(stripFences(text));
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t: unknown): t is string => typeof t === "string")
        : [],
    };
  } catch {
    return { summary: text.slice(0, 500), tags: [] };
  }
}

/**
 * Mirror of `analyzeMediaWithCustomPrompt`.
 *
 * For videos, `mediaUrl` is required.
 */
export async function analyzeMediaWithOpenRouterCustomPrompt(
  mediaBytes: Buffer,
  mimeType: string,
  prompt: string,
  mediaUrl?: string | null
): Promise<string | null> {
  let text: string | null;

  try {
    text = await callOpenRouterVision(mediaBytes, mimeType, prompt, mediaUrl);
  } catch (error) {
    console.error(
      "[openrouter.analyzeMediaWithCustomPrompt] OpenRouter API call failed:",
      error
    );
    return null;
  }

  if (!text) return null;
  return stripFences(text);
}