import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creatorId = request.nextUrl.searchParams.get("creatorId");
  if (!creatorId) return NextResponse.json({ error: "Missing creatorId" }, { status: 400 });

  // PostgREST caps selects at 1000 rows, so paginate to pull every
  // uncategorized file for this creator.
  const PAGE_SIZE = 1000;
  const uncategorized: { id: string; ai_tags: string[] | null }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("media_files")
      .select("id, ai_tags")
      .eq("creator_id", creatorId)
      .is("folder_id", null)
      .not("ai_tags", "is", null)
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data) break;
    uncategorized.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  if (uncategorized.length === 0) {
    return NextResponse.json({ suggestions: [] });
  }

  // Count tag frequency across uncategorized files. Normalize casing/whitespace
  // so "Indoor" and "indoor" collapse into one bucket.
  const tagCounts = new Map<string, { display: string; ids: string[] }>();
  uncategorized.forEach((file) => {
    const tags = file.ai_tags;
    if (!tags) return;
    for (const raw of tags) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      const entry = tagCounts.get(key) ?? { display: trimmed, ids: [] };
      entry.ids.push(file.id);
      tagCounts.set(key, entry);
    }
  });

  // Good folder candidates are tags that split the collection meaningfully —
  // not so broad they cover most of it (e.g. "indoor", "woman") and not so
  // rare they'd make a trivial folder. Aim for ~5%-35% of uncategorized.
  const total = uncategorized.length;
  const minCount = Math.max(5, Math.floor(total * 0.02));
  const maxCount = Math.max(minCount + 1, Math.floor(total * 0.25));

  let candidates = [...tagCounts.values()].filter(
    (t) => t.ids.length >= minCount && t.ids.length <= maxCount
  );

  // If the sweet-spot is too strict for a small library, relax the ceiling.
  if (candidates.length < 3) {
    candidates = [...tagCounts.values()].filter((t) => t.ids.length >= 2);
  }

  const suggestions = candidates
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, 8)
    .map((t) => ({
      folderName: t.display.charAt(0).toUpperCase() + t.display.slice(1),
      mediaIds: t.ids,
      count: t.ids.length,
    }));

  return NextResponse.json({ suggestions });
}
