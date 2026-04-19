import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clusterTags } from "@/lib/gemini";

export const maxDuration = 120;

type TagCount = { tag: string; count: number };

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const creatorId: string | undefined = body.creatorId;
    const apply: boolean = body.apply === true;
    if (!creatorId) {
      return NextResponse.json(
        { error: "Missing creatorId" },
        { status: 400 }
      );
    }

    // 1) Pull every file's tags for this creator, paging past the 1000 cap.
    const PAGE_SIZE = 1000;
    const files: { id: string; ai_tags: string[] | null }[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("media_files")
        .select("id, ai_tags")
        .eq("creator_id", creatorId)
        .range(from, from + PAGE_SIZE - 1);
      if (error || !data) break;
      files.push(...data);
      if (data.length < PAGE_SIZE) break;
    }

    if (files.length === 0) {
      return NextResponse.json({ mapping: {}, updatedCount: 0, totalFiles: 0 });
    }

    // 2) Build tag frequency table (normalized to lowercase/trimmed).
    const counts = new Map<string, number>();
    for (const f of files) {
      if (!f.ai_tags) continue;
      for (const raw of f.ai_tags) {
        if (typeof raw !== "string") continue;
        const key = raw.trim().toLowerCase();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const tagList: TagCount[] = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    // 3) Ask Gemini to cluster synonyms.
    const mapping = await clusterTags(tagList);

    // 4) Preview stats — how many tags merged, how many files would change.
    const mergedCount = Object.keys(mapping).length;
    let wouldChange = 0;
    const updates: { id: string; ai_tags: string[] }[] = [];
    for (const f of files) {
      if (!f.ai_tags) continue;
      const seen = new Set<string>();
      const next: string[] = [];
      let changed = false;
      for (const raw of f.ai_tags) {
        if (typeof raw !== "string") continue;
        const normalized = raw.trim().toLowerCase();
        if (!normalized) {
          changed = true;
          continue;
        }
        const canonical = mapping[normalized] ?? normalized;
        if (canonical !== raw) changed = true;
        if (seen.has(canonical)) {
          changed = true;
          continue;
        }
        seen.add(canonical);
        next.push(canonical);
      }
      if (changed) {
        wouldChange++;
        updates.push({ id: f.id, ai_tags: next });
      }
    }

    if (!apply) {
      return NextResponse.json({
        mapping,
        mergedCount,
        totalTags: tagList.length,
        wouldChange,
        totalFiles: files.length,
      });
    }

    // 5) Apply updates in batches. Supabase has no bulk-update-by-id-with-
    //    different-values primitive, so we fan out parallel small updates.
    const BATCH = 25;
    let updated = 0;
    for (let i = 0; i < updates.length; i += BATCH) {
      const slice = updates.slice(i, i + BATCH);
      const results = await Promise.all(
        slice.map((u) =>
          supabase
            .from("media_files")
            .update({ ai_tags: u.ai_tags })
            .eq("id", u.id)
        )
      );
      for (const r of results) {
        if (!r.error) updated++;
      }
    }

    return NextResponse.json({
      mapping,
      mergedCount,
      totalTags: tagList.length,
      wouldChange,
      updatedCount: updated,
      totalFiles: files.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Merge-tags error: ${message}` },
      { status: 500 }
    );
  }
}
