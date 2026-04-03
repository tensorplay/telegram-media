import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { mediaIds, folderId } = await request.json();
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    return NextResponse.json({ error: "Missing mediaIds" }, { status: 400 });
  }

  const { error } = await supabase
    .from("media_files")
    .update({ folder_id: folderId ?? null })
    .in("id", mediaIds);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, moved: mediaIds.length });
}
