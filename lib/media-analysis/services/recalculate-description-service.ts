import { getSignedViewUrl } from "@/lib/r2";
import {
  analyzeMediaWithCustomPrompt,
} from "@/lib/media-ai-provider";

export type SupabaseClientLike = {
  from: (table: string) => any;
};

export type AnalysisRow = {
  id: number;
  media_file_id: string | null;
  r2_key: string | null;
  media_type: string | null;
  description: string | null;
  taxonomy: Record<string, any> | null;
};

import { linkOnlyFansBundleItemsToAnalysis } from "@/lib/media-analysis/services/link-onlyfans-bundle-items";

type TagDescriptionMap = Map<
  string,
  {
    description: string;
  }
>;

function getContentTypeFromRow(row: AnalysisRow): string {
  const mediaType = String(row.media_type || "").toLowerCase();
  const r2Key = String(row.r2_key || "").toLowerCase();

  if (mediaType === "video") return "video/mp4";
  if (mediaType === "image") return "image/jpeg";
  if (mediaType === "audio") return "audio/mpeg";

  if (r2Key.endsWith(".mp4")) return "video/mp4";
  if (r2Key.endsWith(".mov")) return "video/quicktime";
  if (r2Key.endsWith(".webm")) return "video/webm";
  if (r2Key.endsWith(".png")) return "image/png";
  if (r2Key.endsWith(".webp")) return "image/webp";
  if (r2Key.endsWith(".gif")) return "image/gif";

  return "image/jpeg";
}

async function fetchMediaBytes(r2Key: string): Promise<Buffer> {
  const signedUrl = await getSignedViewUrl(r2Key, 600);

  const response = await fetch(signedUrl, {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch media from R2: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function loadTagDescriptions({
  supabase,
  taxonomy,
}: {
  supabase: SupabaseClientLike;
  taxonomy: Record<string, any> | null;
}): Promise<TagDescriptionMap> {
  const categories = new Set<string>();

  if (taxonomy && typeof taxonomy === "object") {
    for (const [key, value] of Object.entries(taxonomy)) {
      if (!value || typeof value !== "object") {
        continue;
      }

      if (key === "ADULT:EXPLICIT_LEVEL") {
        continue;
      }

      const confirmed = Array.isArray((value as any).confirmed)
        ? (value as any).confirmed
        : [];

      for (const tag of confirmed) {
        if (typeof tag === "string" && tag.trim()) {
          categories.add(tag.trim().toUpperCase());
        }
      }
    }
  }

  if (categories.size === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("media_taxonomy")
    .select("taxonomy_domain, category, description")
    .eq("taxonomy_domain", "ADULT")
    .in("category", Array.from(categories));

  if (error) {
    throw new Error(error.message);
  }

  const map: TagDescriptionMap = new Map();

  for (const row of data ?? []) {
    map.set(String(row.category).toUpperCase(), {
      description: row.description,
    });
  }

  return map;
}

function buildDescriptionPrompt({
  initialSummary,
  taxonomy,
  tagDescriptions,
}: {
  initialSummary: string;
  taxonomy: Record<string, any> | null;
  tagDescriptions: TagDescriptionMap;
}) {
  const taxonomySections: string[] = [];

  if (taxonomy && typeof taxonomy === "object") {
    for (const [key, value] of Object.entries(taxonomy)) {
      if (!value || typeof value !== "object") {
        continue;
      }

      if (key === "ADULT:EXPLICIT_LEVEL") {
        continue;
      }

      const confirmed = Array.isArray((value as any).confirmed)
        ? (value as any).confirmed
        : [];

      const justification =
        typeof (value as any).justification === "string"
          ? (value as any).justification.trim()
          : "";

      const confirmedLines: string[] = [];

      for (const tag of confirmed) {
        const tagInfo = tagDescriptions.get(String(tag).toUpperCase());

        if (tagInfo?.description) {
          confirmedLines.push(`${tag} — ${tagInfo.description}`);
        } else {
          confirmedLines.push(String(tag));
        }
      }

      const hasConfirmed = confirmed.length > 0;
      const hasJustification = justification.length > 0;

      if (!hasConfirmed && !hasJustification) {
        continue;
      }

      const sections: string[] = [];

      sections.push(`CATEGORY: ${key}`);

      if (confirmedLines.length > 0) {
        sections.push(
          `CONFIRMED TAGS:\n${confirmedLines.map((x) => `- ${x}`).join("\n")}`
        );
      }

      if (justification) {
        sections.push(
          `JUSTIFICATION:\n${justification}`
        );
      }

      taxonomySections.push(sections.join("\n\n"));
    }
  }

  return `
You are an expert adult-content librarian and media cataloging specialist.

Your job is to create accurate, detailed, searchable descriptions for adult media assets stored in a professional content library.

The description must maximize discoverability and retrieval quality while remaining factual and grounded in the provided evidence.

GENERAL VISUAL SUMMARY:
${initialSummary}

TAXONOMY ANALYSIS:
${taxonomySections.join("\n\n")}

Requirements:

- Produce a single final description.
- Use the visual summary and taxonomy analysis together.
- Confirmed taxonomy tags are high-confidence facts.
- Prefer confirmed tags over any visual inference.
- Use taxonomy justifications as supporting evidence.
- Include important searchable keywords naturally.
- Mention performer appearance, body traits, hair, eye color, clothing, nudity level, accessories, environment, pose, activities, and scene dynamics when relevant.
- If confirmed tags indicate lingerie, swimwear, fetish elements, partial nudity, full nudity, explicit exposure, masturbation, sexual activity, or other adult content, describe those elements clearly and factually.
- Do not sanitize, soften, censor, or omit adult-content details that are confirmed by the taxonomy.
- Explicitly mention nudity level, exposed body parts, lingerie, fetish elements, sexual activities, and erotic dynamics whenever they are confirmed by the taxonomy.
- Confirmed tags should normally appear in the final description when relevant.
- When a confirmed tag represents an important searchable characteristic, include it explicitly in the description rather than implying it indirectly.
- Use terminology consistent with adult-content cataloging and content-library search systems.
- The description should be optimized for search, filtering, tagging, retrieval, and content discovery.
- Prioritize factual accuracy over politeness or euphemisms.
- Use direct terminology when supported by the evidence.
- When confirmed tags indicate adult content, the final description should explicitly describe those characteristics using factual adult-content terminology rather than generic or euphemistic language.
- Be descriptive rather than promotional.
- Do not write marketing copy.
- Do not write roleplay text.
- Do not be flirtatious.
- Do not invent details.
- Do not invent camera angles.
- Do not invent body features not supported by the visual summary or taxonomy.
- Avoid repeating the same information.
- Keep the description concise but information-dense (40-120 words).
- Output only the final description.

FINAL DESCRIPTION:
`.trim();
}

function getHumanMediaLabelFromContentType(contentType: string): "video" | "photo" | "audio" {
  const normalized = String(contentType || "").toLowerCase();

  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";

  return "photo";
}

function normalizeMediaLabelInText(text: string, contentType: string): string {
  const value = String(text || "").trim();

  if (!value) {
    return "";
  }

  const label = getHumanMediaLabelFromContentType(contentType);

  // Do not touch real videos.
  if (label === "video") {
    return value;
  }

  return value
    // Preserve the meaning of "home video style" without keeping the word video.
    .replace(/\bhome video style\b/gi, "homemade-style")
    .replace(/\bhome-video style\b/gi, "homemade-style")
    .replace(/\bhome video-style\b/gi, "homemade-style")
    .replace(/\bhome-video-style\b/gi, "homemade-style")
    .replace(/\bhome_video_style\b/gi, "HOMEMADE_STYLE")

    // Preserve the meaning of "home video" without keeping the word video.
    .replace(/\bhome video\b/gi, "homemade")
    .replace(/\bhome-video\b/gi, "homemade")
    .replace(/\bhome_video\b/gi, "HOMEMADE")

    // Remove video globally after special cases.
    .replace(/\bvideos\b/gi, `${label}s`)
    .replace(/\bvideo\b/gi, label);
}

export async function recalculateDescriptionForAnalysisRow({
  supabase,
  row,
}: {
  supabase: SupabaseClientLike;
  row: AnalysisRow;
}) {
  if (!row.r2_key) {
    throw new Error("Analysis row has no r2_key");
  }

  const mediaBytes = await fetchMediaBytes(row.r2_key);
  const contentType = getContentTypeFromRow(row);

  const rawInitialSummary = await analyzeMediaWithCustomPrompt(
    mediaBytes,
    contentType,
    `
  You are an expert adult-content media analyst.

  Your job is to create a factual visual summary of the attached media for a professional searchable content library.

  This summary will later be combined with taxonomy tags and category justifications to produce the final catalog description.

  Focus only on observable evidence from the media itself.

  Describe relevant details such as:
  - performer appearance, body type, hair, visible tattoos, makeup, and accessories
  - clothing, lingerie, swimwear, nudity level, and exposed body parts
  - setting, background, lighting, camera framing, and pose
  - activity, movement, interaction, and scene dynamics
  - adult or sexual elements when visibly present
  - whether the content appears to be solo, partnered, explicit, teasing, casual, or non-explicit

  Rules:
  - Be factual and specific.
  - Do not write marketing copy.
  - Do not write roleplay text.
  - Do not be flirtatious.
  - Do not invent details that are not visible or audible.
  - Do not overstate uncertainty.
  - Do not censor adult-content details when they are visible.
  - Use direct adult-content cataloging language when supported by the media.
  - Keep the summary concise but information-dense.
  - Output only the visual summary.

  VISUAL SUMMARY:
  `.trim()
  );

  const initialSummary = normalizeMediaLabelInText(
    String(rawInitialSummary || ""),
    contentType
  );

  if (!initialSummary) {
    throw new Error("Description summary custom prompt returned empty summary");
  }

  const tagDescriptions = await loadTagDescriptions({
    supabase,
    taxonomy: row.taxonomy,
  });

  const descriptionPrompt = buildDescriptionPrompt({
    initialSummary,
    taxonomy: row.taxonomy,
    tagDescriptions,
  });

  console.log(
    "[recalculate-description] prompt\n" +
    "==================================================\n" +
    descriptionPrompt +
    "\n=================================================="
  );

  const rawDescription = await analyzeMediaWithCustomPrompt(
    mediaBytes,
    contentType,
    descriptionPrompt
  );

  console.log(
    "[recalculate-description] response\n" +
    "==================================================\n" +
    String(rawDescription) +
    "\n=================================================="
  );

  const description = normalizeMediaLabelInText(
    String(rawDescription),
    contentType
  );

  if (!description) {
    throw new Error("Description analysis returned empty description");
  }

  const { data: updatedRow, error } = await supabase
    .from("media_content_analysis")
    .update({
      description,
    })
    .eq("id", row.id)
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  const bundleLinkResult = await linkOnlyFansBundleItemsToAnalysis({
    supabase,
    mediaFileId: String(updatedRow.media_file_id || row.media_file_id || ""),
    analysisId: Number(updatedRow.id || row.id),
  });

  return {
    mediaContentAnalysisId: row.id,
    mediaFileId: row.media_file_id,
    r2Key: row.r2_key,
    success: true,
    description,
    bundleLinkResult,
    analysis: updatedRow,
  };
}