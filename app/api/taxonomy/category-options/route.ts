import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTaxonomyCategoryOptions } from "@/lib/media-analysis/taxonomy-category-options";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function getInternalApiKey() {
  return process.env.MULTIPLATFORM_MEDIA_API_KEY || "";
}

export async function GET(request: NextRequest) {
  try {
    const internalApiKey = getInternalApiKey();
    const requestApiKey = request.headers.get("x-api-key");

    if (!internalApiKey || requestApiKey !== internalApiKey) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const domain = String(request.nextUrl.searchParams.get("domain") || "ADULT")
      .trim()
      .toUpperCase();

    const supabase = await createClient();

    const options = await getTaxonomyCategoryOptions({
      supabase,
      domain,
    });

    return NextResponse.json({
      ok: true,
      domain,
      options,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}