import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { embedText } from "@/lib/gemini";

type Match = { id: string; similarity: number };

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { query, creatorId } = await request.json();
    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    const trimmed = query.trim();
    const lower = trimmed.toLowerCase();
    const merged = new Map<string, Match>();
    const upsert = (id: string, similarity: number) => {
      const prev = merged.get(id);
      if (!prev || similarity > prev.similarity) {
        merged.set(id, { id, similarity });
      }
    };

    // 1) Exact tag hits — anything where ai_tags contains the query literally.
    //    These are the highest-confidence matches so we pin them at 1.0.
    //    Page through PostgREST's 1000-row cap.
    const PAGE_SIZE = 1000;
    for (let from = 0; ; from += PAGE_SIZE) {
      let q = supabase
        .from("media_files")
        .select("id")
        .contains("ai_tags", [lower])
        .range(from, from + PAGE_SIZE - 1);
      if (creatorId) q = q.eq("creator_id", creatorId);
      const { data, error } = await q;
      if (error || !data) break;
      data.forEach((row) => upsert(row.id, 1.0));
      if (data.length < PAGE_SIZE) break;
    }

    // 2) Substring hits in filename or AI summary — useful for queries the
    //    tagger didn't emit (e.g. brand names, specific locations).
    //    Strip chars that would break PostgREST's or() syntax or act as LIKE
    //    wildcards the user didn't intend.
    const safe = trimmed.replace(/[,()%_*\\]/g, " ").trim();
    if (safe) {
      let q = supabase
        .from("media_files")
        .select("id")
        .or(`filename.ilike.%${safe}%,ai_summary.ilike.%${safe}%`)
        .limit(1000);
      if (creatorId) q = q.eq("creator_id", creatorId);
      const { data } = await q;
      data?.forEach((row) => upsert(row.id, 0.95));
    }

    // 3) Semantic neighbors — embed the query and pull similar media.
    //    Bump match_count well beyond the old hardcoded 50 so users get a
    //    full page of results for broad queries.
    try {
      const queryEmbedding = await embedText(trimmed);
      if (queryEmbedding.length > 0) {
        const { data, error } = await supabase.rpc("match_media", {
          query_embedding: JSON.stringify(queryEmbedding),
          match_count: 500,
          filter_creator_id: creatorId ?? null,
        });
        if (!error && data) {
          (data as Match[]).forEach((row) => upsert(row.id, row.similarity));
        }
      }
    } catch (err) {
      console.error("[search] embed/semantic step failed:", err);
    }

    const results = [...merged.values()].sort(
      (a, b) => b.similarity - a.similarity
    );

    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Search error: ${message}` },
      { status: 500 }
    );
  }
}
