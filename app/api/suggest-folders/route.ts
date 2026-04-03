import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creatorId = request.nextUrl.searchParams.get("creatorId");
  if (!creatorId) return NextResponse.json({ error: "Missing creatorId" }, { status: 400 });

  const { data: uncategorized } = await supabase
    .from("media_files")
    .select("id, ai_tags")
    .eq("creator_id", creatorId)
    .is("folder_id", null)
    .not("ai_tags", "is", null);

  if (!uncategorized || uncategorized.length === 0) {
    return NextResponse.json({ suggestions: [] });
  }

  // Count tag frequency across uncategorized files
  const tagCounts = new Map<string, string[]>();
  uncategorized.forEach((file) => {
    const tags = file.ai_tags as string[];
    if (!tags) return;
    tags.forEach((tag) => {
      const existing = tagCounts.get(tag) ?? [];
      existing.push(file.id);
      tagCounts.set(tag, existing);
    });
  });

  // Find tags that appear in 2+ files -- good folder candidates
  const suggestions: { folderName: string; mediaIds: string[]; count: number }[] = [];
  const usedIds = new Set<string>();

  const sorted = [...tagCounts.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [tag, ids] of sorted) {
    const unusedIds = ids.filter((id) => !usedIds.has(id));
    if (unusedIds.length < 2) continue;

    const folderName = tag.charAt(0).toUpperCase() + tag.slice(1);
    suggestions.push({
      folderName,
      mediaIds: unusedIds,
      count: unusedIds.length,
    });
    unusedIds.forEach((id) => usedIds.add(id));

    if (suggestions.length >= 5) break;
  }

  return NextResponse.json({ suggestions });
}
