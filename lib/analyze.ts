import { getSignedViewUrl } from "@/lib/r2";
import { embedMedia, analyzeMedia } from "@/lib/gemini";
import { createClient } from "@/lib/supabase/server";

/**
 * Run AI analysis on a media file: generate embedding + summary/tags,
 * then update the database row. Called server-side after upload.
 */
export async function runAnalysis(mediaId: string): Promise<void> {
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

  const signedUrl = await getSignedViewUrl(media.r2_key, 600);

  const res = await fetch(signedUrl);
  if (!res.ok) {
    console.error(`[analyze] Failed to fetch media from R2: ${res.status}`);
    return;
  }

  const mediaBytes = Buffer.from(await res.arrayBuffer());

  const isVideo = media.content_type.startsWith("video/");
  const maxEmbedSize = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
  const canEmbed = mediaBytes.length <= maxEmbedSize;

  const [embeddingResult, analysisResult] = await Promise.allSettled([
    canEmbed
      ? embedMedia(mediaBytes, media.content_type)
      : Promise.resolve(null),
    analyzeMedia(
      isVideo && mediaBytes.length > 20 * 1024 * 1024
        ? mediaBytes.subarray(0, 20 * 1024 * 1024)
        : mediaBytes,
      media.content_type
    ),
  ]);

  const embedding =
    embeddingResult.status === "fulfilled" ? embeddingResult.value : null;
  const analysis =
    analysisResult.status === "fulfilled"
      ? analysisResult.value
      : { summary: "", tags: [] };

  if (embeddingResult.status === "rejected") {
    console.error(`[analyze] Embedding failed:`, embeddingResult.reason);
  }
  if (analysisResult.status === "rejected") {
    console.error(`[analyze] Analysis failed:`, analysisResult.reason);
  }

  const updateData: Record<string, unknown> = {
    ai_summary: analysis.summary || null,
    ai_tags: analysis.tags.length > 0 ? analysis.tags : null,
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
  }
}
