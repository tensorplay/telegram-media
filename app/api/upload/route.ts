import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSignedUploadUrl } from "@/lib/r2";

const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

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

    const { error: dbError } = await supabase.from("media_files").insert({
      creator_id: creatorId,
      filename,
      r2_key: r2Key,
      content_type: contentType,
      size_bytes: size ?? 0,
      uploaded_by: user.id,
    });

    if (dbError) {
      return NextResponse.json(
        { error: `DB error: ${dbError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ uploadUrl, r2Key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Server error: ${message}` },
      { status: 500 }
    );
  }
}
