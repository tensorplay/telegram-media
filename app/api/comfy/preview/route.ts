import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { viewBuffer } from "@/lib/comfy";

/**
 * Proxies ComfyUI's /view endpoint so the browser can render the result
 * without talking to the Comfy server directly. Used as the `src` of the
 * dialog's <img> / <video> preview.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const filename = request.nextUrl.searchParams.get("filename");
    const subfolder = request.nextUrl.searchParams.get("subfolder") ?? "";
    const type = request.nextUrl.searchParams.get("type") ?? "output";
    if (!filename) {
      return NextResponse.json({ error: "Missing filename" }, { status: 400 });
    }

    const { buffer, contentType } = await viewBuffer({ filename, subfolder, type });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[comfy/preview]", err);
    return NextResponse.json(
      { error: `Preview error: ${message}` },
      { status: 500 }
    );
  }
}
