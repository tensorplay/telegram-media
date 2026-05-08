import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSignedViewUrl } from "@/lib/r2";
import {
  buildHeadSwapImageWorkflow,
  buildHeadSwapVideoWorkflow,
  queuePrompt,
  uploadInput,
  type ComfyMode,
} from "@/lib/comfy";

export const maxDuration = 60;

interface GenerateBody {
  creatorId?: string;
  mode?: ComfyMode;
  headMediaId?: string;
  faceMediaId?: string;
  prompt?: string;
  seed?: number;
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

    const body = (await request.json().catch(() => ({}))) as GenerateBody;
    const { creatorId, mode, headMediaId, faceMediaId, prompt, seed } = body;

    if (!creatorId || !mode || !headMediaId || !faceMediaId || !prompt?.trim()) {
      return NextResponse.json(
        { error: "Missing creatorId, mode, headMediaId, faceMediaId, or prompt" },
        { status: 400 }
      );
    }
    if (mode !== "image" && mode !== "video") {
      return NextResponse.json({ error: "mode must be image or video" }, { status: 400 });
    }

    const { data: rows, error: rowsError } = await supabase
      .from("media_files")
      .select("id, r2_key, content_type, creator_id")
      .in("id", [headMediaId, faceMediaId]);

    if (rowsError || !rows || rows.length < 2) {
      return NextResponse.json(
        { error: rowsError?.message ?? "Could not load both inputs" },
        { status: 400 }
      );
    }

    const head = rows.find((r) => r.id === headMediaId);
    const face = rows.find((r) => r.id === faceMediaId);
    if (!head || !face) {
      return NextResponse.json({ error: "Inputs not found" }, { status: 400 });
    }
    if (head.creator_id !== creatorId || face.creator_id !== creatorId) {
      return NextResponse.json(
        { error: "Inputs do not belong to this creator" },
        { status: 403 }
      );
    }

    // Validate MIME types match the mode. Body input shape depends on mode;
    // face is always an image.
    if (mode === "image" && !head.content_type.startsWith("image/")) {
      return NextResponse.json(
        { error: "Image mode requires an image as the body input" },
        { status: 400 }
      );
    }
    if (mode === "video" && !head.content_type.startsWith("video/")) {
      return NextResponse.json(
        { error: "Video mode requires a video as the body input" },
        { status: 400 }
      );
    }
    if (!face.content_type.startsWith("image/")) {
      return NextResponse.json(
        { error: "Face input must be an image" },
        { status: 400 }
      );
    }

    // Pull both files from R2 in parallel and upload to ComfyUI.
    const [headBytes, faceBytes] = await Promise.all([
      fetchR2Bytes(head.r2_key),
      fetchR2Bytes(face.r2_key),
    ]);

    const headFilename = sanitizeFilename(head.r2_key, head.content_type);
    const faceFilename = sanitizeFilename(face.r2_key, face.content_type);

    const [headRef, faceRef] = await Promise.all([
      uploadInput(headBytes, headFilename, head.content_type),
      uploadInput(faceBytes, faceFilename, face.content_type),
    ]);

    const workflow =
      mode === "image"
        ? buildHeadSwapImageWorkflow({
            bodyImage: headRef.filename,
            faceImage: faceRef.filename,
            prompt,
            seed,
          })
        : buildHeadSwapVideoWorkflow({
            bodyVideo: headRef.filename,
            faceImage: faceRef.filename,
            prompt,
            seed,
          });

    const promptId = await queuePrompt(workflow);

    return NextResponse.json({ promptId, mode });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[comfy/generate]", err);
    return NextResponse.json(
      { error: `Generate error: ${message}` },
      { status: 500 }
    );
  }
}

async function fetchR2Bytes(key: string): Promise<Buffer> {
  const url = await getSignedViewUrl(key, 600);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`R2 fetch failed for ${key}: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function sanitizeFilename(r2Key: string, contentType: string): string {
  // Take the last path segment (e.g. "{ts}-photo.jpg") so ComfyUI's input
  // folder doesn't get a path-traversal-looking name. Add an extension if
  // none is present, derived from content type.
  const base = r2Key.split("/").pop() ?? r2Key;
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  const ext = extFromMime(contentType);
  return ext ? `${base}.${ext}` : base;
}

function extFromMime(mime: string): string | null {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      return null;
  }
}
