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
 * Ask Gemini to collapse near-duplicate tags into canonical forms.
 * Returns a mapping of variant -> canonical. Tags that don't appear as keys
 * should be left alone.
 */
export async function clusterTags(
  tags: { tag: string; count: number }[]
): Promise<Record<string, string>> {
  if (tags.length === 0) return {};

  const listing = tags
    .map((t) => `${t.tag} (${t.count})`)
    .join("\n");

  const prompt = `You are cleaning up a tag vocabulary used to organize a photo library. Below is a list of tags with their usage counts. Many are near-duplicates, plurals, or synonyms that should be merged into a single canonical form.

Return a JSON object mapping variant tags to their canonical form. Rules:
- Only include tags that should be merged. Leave unique or already-canonical tags out of the output.
- Prefer the most common and shortest canonical form (e.g. "indoor" not "indoors", "necklace" not "neckless").
- Merge obvious plurals, spelling variants, and near-synonyms ("smiling"/"smile", "red hair"/"red-haired").
- Do NOT merge tags that describe genuinely different things, even if related. Examples that must stay separate: "cross necklace" vs "pearl necklace" vs "hoop earrings" (different jewelry); "green eyes" vs "blue eyes"; "indoor" vs "outdoor"; "daytime" vs "evening" vs "night".
- Do not invent canonical tags that aren't in the input list.

Return ONLY the raw JSON object, no markdown fences, no prose.

Tags:
${listing}`;

  const response = await ai.models.generateContent({
    model: VISION_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const text = response.text?.trim() ?? "{}";
  const cleaned = text.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "");

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const validTags = new Set(tags.map((t) => t.tag));
      const mapping: Record<string, string> = {};
      for (const [variant, canonical] of Object.entries(parsed)) {
        if (typeof canonical !== "string") continue;
        const v = variant.trim().toLowerCase();
        const c = canonical.trim().toLowerCase();
        if (!v || !c || v === c) continue;
        if (!validTags.has(v) || !validTags.has(c)) continue;
        mapping[v] = c;
      }
      // Collapse transitive mappings: a->b, b->c ===> a->c.
      for (const key of Object.keys(mapping)) {
        let target = mapping[key];
        const seen = new Set<string>([key]);
        while (mapping[target] && !seen.has(target)) {
          seen.add(target);
          target = mapping[target];
        }
        mapping[key] = target;
      }
      return mapping;
    }
  } catch {
    console.error("[clusterTags] Failed to parse Gemini response:", text);
  }
  return {};
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


export async function analyzeMediaWithCustomPrompt(
  mediaBytes: Buffer,
  mimeType: string,
  prompt: string
): Promise<unknown> {
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
              text: prompt,
            },
          ],
        },
      ],
    });

    return response.text?.trim() ?? "";
  } finally {
    if (fileToCleanup) {
      await cleanupGeminiFile(fileToCleanup);
    }
  }
}
