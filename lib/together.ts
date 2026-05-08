/**
 * Together AI client used as a fallback when Gemini's hard safety filter
 * refuses to analyze explicit content. The surface intentionally mirrors
 * `analyzeMedia` / `analyzeMediaWithCustomPrompt` in `lib/gemini.ts` so the
 * caller can hot-swap providers without restructuring the prompt.
 *
 * Together's chat completions API is OpenAI-compatible. We send the image
 * inline as a base64 data URL, which avoids exposing R2 contents to a third
 * party gateway and keeps the fallback path stateless.
 *
 * Videos are NOT supported here — Qwen vision-chat works image-only via this
 * endpoint, and base64-encoding a 100 MB video in a JSON body is a non-starter.
 * The caller should keep using Gemini for video.
 */
import Together from "together-ai";

const TOGETHER_VISION_MODEL =
  process.env.TOGETHER_VISION_MODEL ?? "Qwen/Qwen3.5-9B";

let cachedClient: Together | null = null;

function getClient(): Together | null {
  if (!process.env.TOGETHER_API_KEY) return null;
  if (!cachedClient) {
    cachedClient = new Together({ apiKey: process.env.TOGETHER_API_KEY });
  }
  return cachedClient;
}

function toDataUrl(mediaBytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${mediaBytes.toString("base64")}`;
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * Returns `null` if Together is unconfigured or the media is unsupported
 * (e.g. video). Returns the raw model text otherwise. Throws on API errors so
 * the caller can decide whether to fall through to a placeholder.
 */
async function callQwenVision(
  mediaBytes: Buffer,
  mimeType: string,
  prompt: string
): Promise<string | null> {
  if (!mimeType.startsWith("image/")) {
    return null;
  }

  const client = getClient();
  if (!client) {
    return null;
  }

  const dataUrl = toDataUrl(mediaBytes, mimeType);

  const response = await client.chat.completions.create({
    model: TOGETHER_VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const text = response.choices?.[0]?.message?.content?.trim() ?? "";
  return text;
}

/**
 * Mirror of `analyzeMedia` from lib/gemini.ts: returns a JSON-parsed
 * `{ summary, tags }`. Returns `null` (not a placeholder) when Together is
 * unconfigured, the media is unsupported, or the model returned nothing — the
 * caller distinguishes "no fallback available" from "fallback ran".
 */
export async function analyzeMediaWithTogether(
  mediaBytes: Buffer,
  mimeType: string
): Promise<{ summary: string; tags: string[] } | null> {
  const prompt = `Analyze this image and return a JSON object with exactly two fields:
1. "summary": A concise 1-2 sentence description of the content.
2. "tags": An array of 5-15 lowercase tags useful for sorting creator content. Include tags for: setting/location, clothing/outfit (or state of undress), mood/vibe, pose/activity, colors, time of day, indoor/outdoor, and any notable elements. Be factually descriptive of what is shown — this is an adult content library, so tags about nudity, lingerie, or explicit acts are expected and useful when applicable.

Return ONLY the raw JSON object, no markdown fences or extra text.`;

  let text: string | null;
  try {
    text = await callQwenVision(mediaBytes, mimeType, prompt);
  } catch (error) {
    console.error("[together.analyzeMedia] Together API call failed:", error);
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
 * Mirror of `analyzeMediaWithCustomPrompt` from lib/gemini.ts. The taxonomy
 * pipeline calls this with structured-output prompts; we return the raw text
 * (with code fences stripped) and let the caller `JSON.parse` as before.
 */
export async function analyzeMediaWithTogetherCustomPrompt(
  mediaBytes: Buffer,
  mimeType: string,
  prompt: string
): Promise<string | null> {
  let text: string | null;
  try {
    text = await callQwenVision(mediaBytes, mimeType, prompt);
  } catch (error) {
    console.error(
      "[together.analyzeMediaWithCustomPrompt] Together API call failed:",
      error
    );
    return null;
  }

  if (!text) return null;
  return stripFences(text);
}
