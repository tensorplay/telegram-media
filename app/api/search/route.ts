import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { embedText } from "@/lib/gemini";

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

    const queryEmbedding = await embedText(query);
    if (queryEmbedding.length === 0) {
      return NextResponse.json(
        { error: "Failed to embed query" },
        { status: 500 }
      );
    }

    const { data, error } = await supabase.rpc("match_media", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: 50,
      filter_creator_id: creatorId ?? null,
    });

    if (error) {
      return NextResponse.json(
        { error: `Search failed: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      results: data ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Search error: ${message}` },
      { status: 500 }
    );
  }
}
