import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runAnalysis } from "@/lib/analyze";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { mediaId } = await request.json();
    if (!mediaId) {
      return NextResponse.json({ error: "Missing mediaId" }, { status: 400 });
    }

    await runAnalysis(mediaId);

    const { data: updated } = await supabase
      .from("media_files")
      .select("ai_summary, ai_tags")
      .eq("id", mediaId)
      .single();

    return NextResponse.json({
      success: true,
      summary: updated?.ai_summary ?? null,
      tags: updated?.ai_tags ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Analyze error: ${message}` },
      { status: 500 }
    );
  }
}
