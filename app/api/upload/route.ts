import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSignedUploadUrl } from "@/lib/r2";
import { runAnalysis } from "@/lib/analyze";

const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

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

    const body = await request.json();
    const { filename, contentType, size, creatorSlug, creatorId } = body;

    if (!filename || !contentType || !creatorSlug || !creatorId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!ACCEPTED_TYPES.has(contentType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${contentType}` },
        { status: 400 }
      );
    }

    const timestamp = Date.now();
    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const r2Key = `creators/${creatorSlug}/${timestamp}-${sanitized}`;

    const uploadUrl = await getSignedUploadUrl(r2Key, contentType);

    const { data: inserted, error: dbError } = await supabase
      .from("media_files")
      .insert({
        creator_id: creatorId,
        filename,
        r2_key: r2Key,
        content_type: contentType,
        size_bytes: size ?? 0,
        uploaded_by: user.id,
      })
      .select("id")
      .single();

    if (dbError || !inserted) {
      return NextResponse.json(
        { error: `DB error: ${dbError?.message ?? "No row returned"}` },
        { status: 500 }
      );
    }

    // Schedule AI analysis to run after the response is sent.
    // The serverless function stays alive until this completes.
    after(async () => {
      // Small delay to let the client finish uploading to R2
      await new Promise((r) => setTimeout(r, 5000));
      await runAnalysis(inserted.id);
    });

    return NextResponse.json({ uploadUrl, r2Key, mediaId: inserted.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Server error: ${message}` },
      { status: 500 }
    );
  }
}
