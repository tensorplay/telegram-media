import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { putToR2 } from "@/lib/r2";
import { viewBuffer, type ComfyMode } from "@/lib/comfy";
import { runAnalysis } from "@/lib/analyze";

// Save flow runs ComfyUI -> R2 -> DB insert -> AI analysis (Gemini), so the
// budget needs to cover the analyze step too. Image analyze typically finishes
// in 5-15s; videos can be longer.
export const maxDuration = 120;

interface SaveBody {
  creatorId?: string;
  creatorSlug?: string;
  mode?: ComfyMode;
  filename?: string;
  subfolder?: string;
  type?: string;
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as SaveBody;
    const { creatorId, creatorSlug, mode, filename, subfolder, type } = body;
    if (!creatorId || !creatorSlug || !mode || !filename) {
      return NextResponse.json(
        { error: "Missing creatorId, creatorSlug, mode, or filename" },
        { status: 400 }
      );
    }
    if (mode !== "image" && mode !== "video") {
      return NextResponse.json({ error: "mode must be image or video" }, { status: 400 });
    }

    // Re-fetch the bytes from ComfyUI rather than trusting any client-supplied
    // URL — keeps the trust boundary at the Comfy server.
    const { buffer, contentType } = await viewBuffer({
      filename,
      subfolder: subfolder ?? "",
      type: type ?? "output",
    });

    const ext = pickExt(filename, mode);
    const ts = Date.now();
    const tool = mode === "image" ? "flux2-headswap" : "ltx-headswap";
    const r2Key = `creators/${creatorSlug}/comfy/${ts}-${tool}.${ext}`;
    const finalContentType =
      contentType !== "application/octet-stream"
        ? contentType
        : mode === "image"
          ? "image/png"
          : "video/mp4";

    await putToR2(r2Key, buffer, finalContentType);

    const displayFilename = `${tool}-${ts}.${ext}`;

    // Insert with empty ai_summary / ai_tags so the analyzer treats this as
    // unanalyzed and runs Gemini for proper content tags. We add the
    // provenance tags afterwards on top of whatever Gemini produces.
    const { data: inserted, error: dbError } = await supabase
      .from("media_files")
      .insert({
        creator_id: creatorId,
        filename: displayFilename,
        r2_key: r2Key,
        content_type: finalContentType,
        size_bytes: buffer.length,
        uploaded_by: user.id,
      })
      .select("id")
      .single();

    if (dbError || !inserted) {
      return NextResponse.json(
        { error: `DB error: ${dbError?.message ?? "No row returned"}` },
        { status: 500 }
      );
    }

    const mediaId: string = inserted.id;

    // Run analysis synchronously so the file already has real content tags by
    // the time the dialog refreshes the grid. Failure is non-fatal — the user
    // can still re-analyze from the inspector.
    try {
      await runAnalysis(mediaId);
    } catch (analyzeErr) {
      console.error("[comfy/save] analyze failed:", analyzeErr);
    }

    // Append provenance tags on top of whatever Gemini produced (read-modify-
    // write to avoid clobbering AI tags written above).
    const provenanceTags =
      mode === "image"
        ? ["source:comfy", "tool:flux2-klein", "head-swap"]
        : ["source:comfy", "tool:ltx-2.3", "head-swap"];
    try {
      const { data: row } = await supabase
        .from("media_files")
        .select("ai_tags")
        .eq("id", mediaId)
        .single();
      const existing = Array.isArray(row?.ai_tags)
        ? row.ai_tags.filter((t: unknown): t is string => typeof t === "string")
        : [];
      const seen = new Set<string>(existing.map((t) => t.toLowerCase()));
      const merged = [...existing];
      for (const t of provenanceTags) {
        if (!seen.has(t)) {
          seen.add(t);
          merged.push(t);
        }
      }
      await supabase
        .from("media_files")
        .update({ ai_tags: merged })
        .eq("id", mediaId);
    } catch (tagErr) {
      console.error("[comfy/save] provenance tag append failed:", tagErr);
    }

    return NextResponse.json({ mediaId, r2Key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[comfy/save]", err);
    return NextResponse.json(
      { error: `Save error: ${message}` },
      { status: 500 }
    );
  }
}

function pickExt(filename: string, mode: ComfyMode): string {
  const m = filename.match(/\.([a-z0-9]{2,5})$/i);
  if (m) return m[1].toLowerCase();
  return mode === "image" ? "png" : "mp4";
}
