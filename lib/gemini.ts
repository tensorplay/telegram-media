import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const EMBEDDING_MODEL = "gemini-embedding-2-preview";
const VISION_MODEL = "gemini-2.5-flash";
const EMBEDDING_DIMS = 768;

/**
 * Embed media (image or video) directly using Gemini Embedding 2's
 * native multimodal support. Returns a 768-dim float array.
 */
export async function embedMedia(
  mediaBytes: Buffer,
  mimeType: string
): Promise<number[]> {
  const base64 = mediaBytes.toString("base64");

  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [
      {
        inlineData: {
          mimeType,
          data: base64,
        },
      },
    ],
    config: {
      outputDimensionality: EMBEDDING_DIMS,
    },
  });

  return response.embeddings?.[0]?.values ?? [];
}

/**
 * Embed a text query into the same 768-dim vector space as media.
 * Used for cross-modal search (text query → find matching images/videos).
 */
export async function embedText(query: string): Promise<number[]> {
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: query,
    config: {
      outputDimensionality: EMBEDDING_DIMS,
    },
  });

  return response.embeddings?.[0]?.values ?? [];
}

/**
 * Analyze media with Gemini Flash vision to produce a human-readable
 * summary and auto-generated tags for sorting/filtering.
 */
export async function analyzeMedia(
  mediaBytes: Buffer,
  mimeType: string
): Promise<{ summary: string; tags: string[] }> {
  const base64 = mediaBytes.toString("base64");

  const response = await ai.models.generateContent({
    model: VISION_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64,
            },
          },
          {
            text: `Analyze this media and return a JSON object with exactly two fields:
1. "summary": A concise 1-2 sentence description of the content.
2. "tags": An array of 5-15 lowercase tags useful for sorting creator content. Include tags for: setting/location, clothing/outfit, mood/vibe, pose/activity, colors, time of day, indoor/outdoor, and any notable elements.

Return ONLY the raw JSON object, no markdown fences or extra text.`,
          },
        ],
      },
    ],
  });

  const text = response.text?.trim() ?? "{}";

  try {
    const cleaned = text.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned);
    return {
      summary: parsed.summary ?? "",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch {
    return { summary: text.slice(0, 500), tags: [] };
  }
}
