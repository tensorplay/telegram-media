// lib/analyze.ts

import { createHash } from "node:crypto";
import { embedMedia, analyzeMedia, embedText } from "@/lib/gemini";
import { runTaxonomyPipeline } from "@/lib/media-analysis/run-taxonomy-pipeline";
import { persistTaxonomyResults } from "@/lib/media-analysis/persist-taxonomy-results";
import { getSignedViewUrl } from "@/lib/r2";
import { createClient } from "@/lib/supabase/server";


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
    .select("r2_key, content_type")
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

  const isVideo = media.content_type.startsWith("video/");
  const isImage = media.content_type.startsWith("image/");
  const mediaType: "video" | "image" | "audio" = isVideo
    ? "video"
    : isImage
      ? "image"
      : "audio";

  const maxEmbedSize = isVideo ? 100 * 1024 * 1024 : 10 * 1024 * 1024;
  const canEmbed = mediaBytes.length <= maxEmbedSize;

  console.log(`[analyze] Running embedding=${canEmbed} + vision analysis...`);

  const [embeddingResult, analysisResult] = await Promise.allSettled([
    canEmbed
      ? embedMedia(mediaBytes, media.content_type)
      : Promise.resolve(null),
    analyzeMedia(mediaBytes, media.content_type),
  ]);

  const embedding =
    embeddingResult.status === "fulfilled" ? embeddingResult.value : null;
  const analysis =
    analysisResult.status === "fulfilled"
      ? analysisResult.value
      : { summary: "", tags: [] };

  let descriptionEmbedding: number[] | null = null;   

  if (embeddingResult.status === "rejected") {
    console.error(`[analyze] Embedding failed:`, embeddingResult.reason);
  } else {
    console.log(`[analyze] Embedding: ${embedding ? `${embedding.length} dims` : "skipped"}`);
  }

  if (analysisResult.status === "rejected") {
    console.error(`[analyze] Vision analysis failed:`, analysisResult.reason);
  } else {
    console.log(`[analyze] Summary: "${analysis.summary.slice(0, 80)}..."`);
    console.log(`[analyze] Tags: [${analysis.tags.join(", ")}]`);
  }

  let taxonomyPipelineResult: Awaited<ReturnType<typeof runTaxonomyPipeline>> | null = null;

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

  const updateData: Record<string, unknown> = {
    ai_summary: analysis.summary || "Analysis completed",
    ai_tags: analysis.tags.length > 0 ? analysis.tags : [],
  };
  if (embedding && embedding.length > 0) {
    updateData.embedding = JSON.stringify(embedding);
  }

  const { error: updateError } = await supabase
    .from("media_files")
    .update(updateData)
    .eq("id", mediaId);

  if (updateError) {
    console.error(`[analyze] DB update failed:`, updateError.message);
  } else {
    console.log(`[analyze] DB updated successfully for ${mediaId}`);
  }

  if (taxonomyPipelineResult && taxonomyPipelineResult.tasks.length > 0) {
    try {
      // TODO: Confirm where creatorId should come from in this project.
      // Do not assume media_files.creator_id exists until the schema is confirmed.
      await persistTaxonomyResults({
        originalFileHash,
        mediaType,
        // TODO: Confirm the real source for referenceName in this project.
        // We are using r2_key temporarily because it is confirmed to exist.        
        referenceName: media.r2_key, 
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
