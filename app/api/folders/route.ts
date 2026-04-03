import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creatorId = request.nextUrl.searchParams.get("creatorId");
  if (!creatorId) return NextResponse.json({ error: "Missing creatorId" }, { status: 400 });

  const { data: folders } = await supabase
    .from("media_folders")
    .select("*")
    .eq("creator_id", creatorId)
    .order("name");

  return NextResponse.json({ folders: folders ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, creatorId, parentId } = await request.json();
  if (!name || !creatorId) {
    return NextResponse.json({ error: "Missing name or creatorId" }, { status: 400 });
  }

  const { data: folder, error } = await supabase
    .from("media_folders")
    .insert({
      name,
      creator_id: creatorId,
      parent_id: parentId ?? null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ folder });
}
