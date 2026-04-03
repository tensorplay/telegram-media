import { getSignedViewUrl } from "@/lib/r2";
import { embedMedia, analyzeMedia } from "@/lib/gemini";
import { createClient } from "@/lib/supabase/server";

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

  const isVideo = media.content_type.startsWith("video/");
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
}
