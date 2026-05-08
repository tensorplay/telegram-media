import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  extractOutput,
  getHistory,
  statusFromHistory,
  type ComfyMode,
} from "@/lib/comfy";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const promptId = request.nextUrl.searchParams.get("promptId");
    const modeParam = request.nextUrl.searchParams.get("mode");
    if (!promptId || (modeParam !== "image" && modeParam !== "video")) {
      return NextResponse.json(
        { error: "Missing promptId or invalid mode" },
        { status: 400 }
      );
    }
    const mode: ComfyMode = modeParam;

    const history = await getHistory(promptId);
    const { status, message } = statusFromHistory(history);

    if (status === "running") {
      return NextResponse.json({ status: "running" });
    }
    if (status === "error") {
      return NextResponse.json({ status: "error", error: message });
    }

    const out = extractOutput(history, mode);
    if (!out) {
      // Completed but we couldn't find the expected output node — surface
      // what we got so the dialog can show a useful message.
      return NextResponse.json(
        {
          status: "error",
          error:
            "ComfyUI finished but no output was produced for the expected node",
        },
        { status: 200 }
      );
    }

    return NextResponse.json({
      status: "done",
      output: {
        filename: out.ref.filename,
        subfolder: out.ref.subfolder,
        type: out.ref.type,
        kind: out.kind,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[comfy/status]", err);
    return NextResponse.json(
      { error: `Status error: ${message}` },
      { status: 500 }
    );
  }
}
