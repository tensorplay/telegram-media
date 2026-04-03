import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSignedViewUrl, deleteFromR2 } from "@/lib/r2";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: media } = await supabase
    .from("media")
    .select("r2_key")
    .eq("id", id)
    .single();

  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const signedUrl = await getSignedViewUrl(media.r2_key, 3600);
  return NextResponse.redirect(signedUrl);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: media } = await supabase
    .from("media")
    .select("r2_key")
    .eq("id", id)
    .single();

  if (!media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await deleteFromR2(media.r2_key);

  await supabase.from("media").delete().eq("id", id);

  return NextResponse.json({ success: true });
}
