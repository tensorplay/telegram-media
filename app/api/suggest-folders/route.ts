import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { suggestAgencyCollections } from "@/lib/gemini";
import { clusterShoots } from "@/lib/shoots";

export const maxDuration = 60;

/**
 * Returns two kinds of suggestions:
 *
 *   shoots[]      — auto-detected shoot clusters. Previewed (not applied) in
 *                   the UI; user confirms which ones to promote.
 *   collections[] — Gemini-proposed agency-mode collections based on tag
 *                   combinations (e.g. "Outdoor athleisure" = outdoor+gym).
 *                   Also previewed before anything is written.
 *
 * Both shapes are safe to render directly in a preview sheet and only
 * mutate data when the user hits Apply.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creatorId = request.nextUrl.searchParams.get("creatorId");
  if (!creatorId)
    return NextResponse.json({ error: "Missing creatorId" }, { status: 400 });

  const PAGE_SIZE = 1000;
  const rows: {
    id: string;
    created_at: string;
    ai_tags: string[] | null;
    filename: string;
    folder_id: string | null;
  }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("media_files")
      .select("id, created_at, ai_tags, filename, folder_id")
      .eq("creator_id", creatorId)
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  if (rows.length === 0) {
    return NextResponse.json({ shoots: [], collections: [] });
  }

  // Shoot suggestions — restrict to *uncategorized* items that don't already
  // carry a shoot:* tag, otherwise the UI gets pushy about re-filing work
  // the user already did.
  const candidateItems = rows.filter(
    (r) =>
      !r.folder_id &&
      !(r.ai_tags ?? []).some(
        (t) => typeof t === "string" && t.toLowerCase().startsWith("shoot:")
      )
  );
  const shoots = clusterShoots(candidateItems)
    .filter((s) => s.items.length >= 3 && !s.promoted)
    .slice(0, 12)
    .map((s) => ({
      slug: s.slug,
      name: s.name,
      count: s.items.length,
      topTags: s.topTags.slice(0, 4),
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      mediaIds: s.items.map((i) => i.id),
    }));

  // Collection suggestions — Gemini chews on tag frequencies.
  const counts = new Map<string, number>();
  for (const r of rows) {
    const tags = r.ai_tags ?? [];
    for (const raw of tags) {
      if (typeof raw !== "string") continue;
      const k = raw.trim().toLowerCase();
      if (!k || k.includes(":") || k === "hero" || k === "variant") continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const tagList = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  let collections: {
    name: string;
    description: string;
    requireTags: string[];
    count: number;
    mediaIds: string[];
  }[] = [];

  try {
    const suggestions = await suggestAgencyCollections(tagList, rows.length);
    // Compute membership for preview.
    collections = suggestions
      .map((s) => {
        const required = s.requireTags.map((t) => t.toLowerCase());
        const memberIds = rows
          .filter((r) => {
            const tags = (r.ai_tags ?? []).map((t) =>
              typeof t === "string" ? t.toLowerCase() : ""
            );
            return required.every((rt) => tags.includes(rt));
          })
          .map((r) => r.id);
        return {
          name: s.name,
          description: s.description,
          requireTags: required,
          count: memberIds.length,
          mediaIds: memberIds,
        };
      })
      .filter((c) => c.count >= 5)
      .slice(0, 8);
  } catch (err) {
    console.error("[suggest-folders] collection error:", err);
  }

  return NextResponse.json({ shoots, collections });
}
