// lib/analyze.ts

import { createHash } from "node:crypto";
import { embedMedia, analyzeMedia, embedText } from "@/lib/gemini";
import { runTaxonomyPipeline } from "@/lib/media-analysis/run-taxonomy-pipeline";
import { persistTaxonomyResults } from "@/lib/media-analysis/persist-taxonomy-results";
import { getSignedViewUrl } from "@/lib/r2";
import { createClient } from "@/lib/supabase/server";

function parseExistingEmbedding(value: unknown): number[] | null {
  if (!value) return null;

  if (Array.isArray(value)) {
    return value.every((n) => typeof n === "number") ? value : null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every((n) => typeof n === "number")
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeExistingTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === "string");
}

function buildDescriptionEmbeddingText(input: {
  summary: string;
  tags: string[];
  explicitnessLevel: string | null;
}): string {
  const parts: string[] = [];

  if (input.summary.trim()) {
    parts.push(input.summary.trim());
  }

  if (input.tags.length > 0) {
    parts.push(`Hashtags: ${input.tags.join(", ")}`);
  }

  if (input.explicitnessLevel) {
    parts.push(`Explicitness: ${input.explicitnessLevel}`);
  }

  return parts.join("\n").trim();
}

export async function runAnalysis(mediaId: string): Promise<void> {
  console.log(`[analyze] Starting analysis for ${mediaId}`);

  const supabase = await createClient();

  const { data: media } = await supabase
    .from("media_files")
    .select("r2_key, content_type, filename, creator_id, ai_summary, ai_tags, embedding")
    .eq("id", mediaId)
    .single();

  if (!media) {
    console.error(`[analyze] Media ${mediaId} not found`);
    return;
  }


  console.log(`[analyze] Fetching from R2: ${media.r2_key} (${media.content_type})`);
  const signedUrl = await getSignedViewUrl(media.r2_key, 600);

  const res = await fetch(signedUrl);
  if (!res.ok) {
    console.error(`[analyze] Failed to fetch media from R2: ${res.status}`);
    return;
  }

  const mediaBytes = Buffer.from(await res.arrayBuffer());
  console.log(`[analyze] Downloaded ${(mediaBytes.length / 1024 / 1024).toFixed(1)} MB`);

  const originalFileHash = createHash("sha256").update(mediaBytes).digest("hex");
  console.log(`[analyze] original_file_hash=${originalFileHash}`);

  const { data: existingTaxonomy, error: existingTaxonomyError } = await supabase
    .from("media_content_analysis")
    .select("id, media_file_id, original_file_hash")
    .eq("original_file_hash", originalFileHash)
    .maybeSingle();

  if (existingTaxonomyError) {
    console.error(
      `[analyze] Failed to check existing taxonomy for ${mediaId}:`,
      existingTaxonomyError.message
    );
    return;
  }

  const hasExistingTaxonomy = !!existingTaxonomy;

  console.log(
    `[analyze] Existing taxonomy check for ${mediaId}: ` +
      `hasExistingTaxonomy=${hasExistingTaxonomy}, ` +
      `existingMediaFileId=${existingTaxonomy?.media_file_id ?? "null"}, ` +
      `originalFileHash=${originalFileHash}`
  );

  const isVideo = media.content_type.startsWith("video/");
  const isImage = media.content_type.startsWith("image/");
  const mediaType: "video" | "image" | "audio" = isVideo
    ? "video"
    : isImage
      ? "image"
      : "audio";

  const existingSummary =
    typeof media.ai_summary === "string" ? media.ai_summary : "";
  const existingTags = normalizeExistingTags(media.ai_tags);
  const existingEmbedding = parseExistingEmbedding(media.embedding);

  const hasExistingLegacyAnalysis =
    existingSummary.trim().length > 0 || existingTags.length > 0;
  const hasExistingEmbedding =
    Array.isArray(existingEmbedding) && existingEmbedding.length > 0;

  const maxEmbedSize = isVideo ? 100 * 1024 * 1024 : 10 * 1024 * 1024;
  const canEmbed = mediaBytes.length <= maxEmbedSize;

  let embedding: number[] | null = hasExistingEmbedding ? existingEmbedding : null;
  let analysis: { summary: string; tags: string[] } = hasExistingLegacyAnalysis
    ? {
        summary: existingSummary,
        tags: existingTags,
      }
    : { summary: "", tags: [] };

  let descriptionEmbedding: number[] | null = null;

  if (hasExistingLegacyAnalysis) {
    console.log("[analyze] Reusing existing legacy analysis from media_files");
    console.log(`[analyze] Summary: "${analysis.summary.slice(0, 80)}..."`);
    console.log(`[analyze] Tags: [${analysis.tags.join(", ")}]`);
  }

  if (hasExistingEmbedding) {
    console.log(`[analyze] Reusing existing media embedding: ${embedding.length} dims`);
  }

  const shouldRunLegacyAnalysis = !hasExistingLegacyAnalysis;
  const shouldRunMediaEmbedding = !hasExistingEmbedding && canEmbed;

  console.log(
    `[analyze] Legacy analysis needed=${shouldRunLegacyAnalysis} | media embedding needed=${shouldRunMediaEmbedding}`
  );

  const [embeddingResult, analysisResult] = await Promise.allSettled([
    shouldRunMediaEmbedding
      ? embedMedia(mediaBytes, media.content_type)
      : Promise.resolve(embedding),
    shouldRunLegacyAnalysis
      ? analyzeMedia(mediaBytes, media.content_type)
      : Promise.resolve(analysis),
  ]);

  if (embeddingResult.status === "fulfilled") {
    embedding = embeddingResult.value;
  } else {
    console.error(`[analyze] Embedding failed:`, embeddingResult.reason);
  }

  if (analysisResult.status === "fulfilled") {
    analysis = analysisResult.value;
  } else {
    console.error(`[analyze] Vision analysis failed:`, analysisResult.reason);
  }

  console.log(
    `[analyze] Embedding: ${embedding && embedding.length > 0 ? `${embedding.length} dims` : "skipped"}`
  );
  console.log(`[analyze] Summary: "${analysis.summary.slice(0, 80)}..."`);
  console.log(`[analyze] Tags: [${analysis.tags.join(", ")}]`);

  let taxonomyPipelineResult: Awaited<ReturnType<typeof runTaxonomyPipeline>> | null = null;

  if (hasExistingTaxonomy) {
    console.log(`[analyze] Reusing existing taxonomy analysis for ${mediaId}`);
  } else {
    try {
      console.log("[analyze] Running taxonomy pipeline...");

      taxonomyPipelineResult = await runTaxonomyPipeline(
        mediaBytes,
        media.content_type
      );

      console.log(
        `[analyze] Taxonomy pipeline completed: ${taxonomyPipelineResult.tasks.length}`
      );

      const descriptionEmbeddingText = buildDescriptionEmbeddingText({
        summary: analysis.summary || "",
        tags: analysis.tags ?? [],
        explicitnessLevel: taxonomyPipelineResult.highestExplicitnessLevel,
      });

      if (descriptionEmbeddingText) {
        descriptionEmbedding = await embedText(descriptionEmbeddingText);

        console.log(
          `[analyze] Description embedding: ${
            descriptionEmbedding ? `${descriptionEmbedding.length} dims` : "empty"
          }`
        );
      }
    } catch (error) {
      console.error("[analyze] Taxonomy pipeline failed:", error);
    }
  }

  const updateData: Record<string, unknown> = {};

  if (!hasExistingLegacyAnalysis) {
    updateData.ai_summary = analysis.summary || "Analysis completed";
    updateData.ai_tags = analysis.tags.length > 0 ? analysis.tags : [];
  }

  if (!hasExistingEmbedding && embedding && embedding.length > 0) {
    updateData.embedding = JSON.stringify(embedding);
  }

  if (Object.keys(updateData).length > 0) {
    const { error: updateError } = await supabase
      .from("media_files")
      .update(updateData)
      .eq("id", mediaId);

    if (updateError) {
      console.error(`[analyze] DB update failed:`, updateError.message);
    } else {
      console.log(`[analyze] DB updated successfully for ${mediaId}`);
    }
  } else {
    console.log(`[analyze] Skipped legacy DB update for ${mediaId} because values already existed`);
  }

  if (taxonomyPipelineResult && taxonomyPipelineResult.tasks.length > 0) {
    try {
      const creatorId = media.creator_id;
      await persistTaxonomyResults({
        creatorId,
        mediaFileId: mediaId,
        r2Key: media.r2_key,
        originalFileHash,
        mediaType,
        referenceName: media.filename,
        description: analysis.summary || null,
        isSexual: taxonomyPipelineResult.isSexual,        
        moderationStatus: "PENDING",
        moderation: {},
        descriptionEmbedding,
        mediaEmbedding: embedding && embedding.length > 0 ? embedding : null,
        tasks: taxonomyPipelineResult.tasks,
      });

      console.log(
        `[analyze] Taxonomy results persisted successfully for ${mediaId}`
      );
    } catch (error) {
      console.error(`[analyze] Failed to persist taxonomy results:`, error);
    }
  }  
}
