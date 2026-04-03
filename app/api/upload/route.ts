import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uploadToR2 } from "@/lib/r2";

const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

const MAX_SIZE = 500 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const creatorSlug = formData.get("creatorSlug") as string | null;
  const creatorId = formData.get("creatorId") as string | null;

  if (!file || !creatorSlug || !creatorId) {
    return NextResponse.json(
      { error: "Missing file, creatorSlug, or creatorId" },
      { status: 400 }
    );
  }

  if (!ACCEPTED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "Unsupported file type" },
      { status: 400 }
    );
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: "File too large (max 500 MB)" },
      { status: 400 }
    );
  }

  const timestamp = Date.now();
  const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const r2Key = `creators/${creatorSlug}/${timestamp}-${sanitized}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadToR2(r2Key, buffer, file.type);

  const { error: dbError } = await supabase.from("media_files").insert({
    creator_id: creatorId,
    filename: file.name,
    r2_key: r2Key,
    content_type: file.type,
    size_bytes: file.size,
    uploaded_by: user.id,
  });

  if (dbError) {
    return NextResponse.json(
      { error: "Failed to save metadata" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, r2_key: r2Key });
}
