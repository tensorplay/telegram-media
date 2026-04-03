import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSignedViewUrl } from "@/lib/r2";
import { embedMedia, analyzeMedia } from "@/lib/gemini";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { mediaId } = await request.json();
    if (!mediaId) {
      return NextResponse.json({ error: "Missing mediaId" }, { status: 400 });
    }

    const { data: media } = await supabase
      .from("media_files")
      .select("r2_key, content_type")
      .eq("id", mediaId)
      .single();

    if (!media) {
      return NextResponse.json({ error: "Media not found" }, { status: 404 });
    }

    const signedUrl = await getSignedViewUrl(media.r2_key, 600);

    const res = await fetch(signedUrl);
    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to fetch media from R2" },
        { status: 500 }
      );
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

    const updateData: Record<string, unknown> = {
      ai_summary: analysis.summary,
      ai_tags: analysis.tags,
    };
    if (embedding && embedding.length > 0) {
      updateData.embedding = JSON.stringify(embedding);
    }

    const { error: updateError } = await supabase
      .from("media_files")
      .update(updateData)
      .eq("id", mediaId);

    if (updateError) {
      return NextResponse.json(
        { error: `DB update failed: ${updateError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      summary: analysis.summary,
      tags: analysis.tags,
      hasEmbedding: embedding !== null && embedding.length > 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Analyze error: ${message}` },
      { status: 500 }
    );
  }
}
