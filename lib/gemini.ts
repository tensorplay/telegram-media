import { GoogleGenAI } from "@google/genai";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const EMBEDDING_MODEL = "gemini-embedding-2-preview";
const VISION_MODEL = "gemini-2.5-flash";
const EMBEDDING_DIMS = 768;

async function uploadToGeminiFileAPI(
  mediaBytes: Buffer,
  mimeType: string
): Promise<{ uri: string; mimeType: string; name: string }> {
  const ext = mimeType.split("/")[1] ?? "bin";
  const tmpPath = join(tmpdir(), `gemini-${randomUUID()}.${ext}`);
  writeFileSync(tmpPath, mediaBytes);

  try {
    const uploaded = await ai.files.upload({
      file: tmpPath,
      config: { mimeType },
    });

    // Poll until the file is processed
    let file = uploaded;
    let attempts = 0;
    while (file.state === "PROCESSING" && attempts < 30) {
      await new Promise((r) => setTimeout(r, 2000));
      file = await ai.files.get({ name: file.name! });
      attempts++;
    }

    if (file.state !== "ACTIVE") {
      throw new Error(`File processing failed: state=${file.state}`);
    }

    return { uri: file.uri!, mimeType: file.mimeType!, name: file.name! };
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // cleanup best-effort
    }
  }
}

async function cleanupGeminiFile(name: string) {
  try {
    await ai.files.delete({ name });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Embed media (image or video) using Gemini Embedding 2.
 * Always uses inline base64 -- the embedding API supports videos up to
 * 120s and images up to 6 per request via inline data.
 */
export async function embedMedia(
  mediaBytes: Buffer,
  mimeType: string
): Promise<number[]> {
  const base64 = mediaBytes.toString("base64");
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [{ inlineData: { mimeType, data: base64 } }],
    config: { outputDimensionality: EMBEDDING_DIMS },
  });
  return response.embeddings?.[0]?.values ?? [];
}

/**
 * Embed a text query into the same vector space as media.
 */
export async function embedText(query: string): Promise<number[]> {
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: query,
    config: { outputDimensionality: EMBEDDING_DIMS },
  });
  return response.embeddings?.[0]?.values ?? [];
}

/**
 * Analyze media with Gemini Flash vision for summary + tags.
 * Images use inline base64; videos use the File API.
 */
export async function analyzeMedia(
  mediaBytes: Buffer,
  mimeType: string
): Promise<{ summary: string; tags: string[] }> {
  const isVideo = mimeType.startsWith("video/");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mediaPart: any;
  let fileToCleanup: string | null = null;

  if (!isVideo && mediaBytes.length < 20 * 1024 * 1024) {
    mediaPart = {
      inlineData: { mimeType, data: mediaBytes.toString("base64") },
    };
  } else {
    const file = await uploadToGeminiFileAPI(mediaBytes, mimeType);
    fileToCleanup = file.name;
    mediaPart = { fileData: { fileUri: file.uri, mimeType: file.mimeType } };
  }

  try {
    const response = await ai.models.generateContent({
      model: VISION_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            mediaPart,
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
      const cleaned = text
        .replace(/^```json?\n?/i, "")
        .replace(/\n?```$/i, "");
      const parsed = JSON.parse(cleaned);
      return {
        summary: parsed.summary ?? "",
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      };
    } catch {
      return { summary: text.slice(0, 500), tags: [] };
    }
  } finally {
    if (fileToCleanup) {
      await cleanupGeminiFile(fileToCleanup);
    }
  }
}
