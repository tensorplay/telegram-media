import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { putToR2 } from "@/lib/r2";
import { viewBuffer, type ComfyMode } from "@/lib/comfy";

export const maxDuration = 60;

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

    const summary =
      mode === "image"
        ? "Generated via ComfyUI Flux 2 head swap"
        : "Generated via ComfyUI LTX 2.3 head-swap video";
    const tags =
      mode === "image"
        ? ["source:comfy", "tool:flux2-klein", "head-swap"]
        : ["source:comfy", "tool:ltx-2.3", "head-swap"];

    const displayFilename = `${tool}-${ts}.${ext}`;

    const { data: inserted, error: dbError } = await supabase
      .from("media_files")
      .insert({
        creator_id: creatorId,
        filename: displayFilename,
        r2_key: r2Key,
        content_type: finalContentType,
        size_bytes: buffer.length,
        uploaded_by: user.id,
        ai_summary: summary,
        ai_tags: tags,
      })
      .select("id")
      .single();

    if (dbError || !inserted) {
      return NextResponse.json(
        { error: `DB error: ${dbError?.message ?? "No row returned"}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ mediaId: inserted.id, r2Key });
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
