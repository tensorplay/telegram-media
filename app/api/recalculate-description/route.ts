// telegram-media/app/api/recalculate-description/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  recalculateDescriptionForAnalysisRow,
  type AnalysisRow,
} from "@/lib/media-analysis/services/recalculate-description-service";

export const maxDuration = 300;

type SupabaseClient =
  | Awaited<ReturnType<typeof createClient>>
  | ReturnType<typeof createAdminClient>;

function isInternalMediaApiRequest(request: NextRequest) {
  const internalApiKey = process.env.MULTIPLATFORM_MEDIA_API_KEY || "";
  const requestApiKey = request.headers.get("x-api-key");

  return !!internalApiKey && requestApiKey === internalApiKey;
}

function normalizeLimit(value: unknown) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 25;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), 100);
}

function normalizeOffset(value: unknown) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(Math.floor(parsed), 0);
}

async function loadRows({
  supabase,
  mediaContentAnalysisId,
  creatorId,
  r2Key,
  limit,
  offset,
  onlyMissingDescription,
}: {
  supabase: SupabaseClient;
  mediaContentAnalysisId: string;
  creatorId: string;
  r2Key: string;
  limit: number;
  offset: number;
  onlyMissingDescription: boolean;
}): Promise<AnalysisRow[]> {
  let query = supabase
    .from("media_content_analysis")
    .select("id, media_file_id, r2_key, media_type, description, taxonomy")
    .not("r2_key", "is", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (mediaContentAnalysisId) {
    query = query.eq("id", Number(mediaContentAnalysisId));
  }

  if (creatorId) {
    query = query.eq("creator_id", creatorId);
  }

  if (r2Key) {
    query = query.eq("r2_key", r2Key);
  }

  if (onlyMissingDescription) {
    query = query.or("description.is.null,description.eq.");
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as AnalysisRow[];
}

export async function POST(request: NextRequest) {
  try {
    const sessionSupabase = await createClient();

    const {
      data: { user },
    } = await sessionSupabase.auth.getUser();

    const isInternalRequest = isInternalMediaApiRequest(request);

    if (!user && !isInternalRequest) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = isInternalRequest
      ? createAdminClient()
      : sessionSupabase;

    const body = await request.json().catch(() => ({}));

    const mediaContentAnalysisId = String(
      body.mediaContentAnalysisId ??
        body.media_content_analysis_id ??
        ""
    ).trim();

    const creatorId = String(body.creatorId ?? body.creator_id ?? "").trim();
    const r2Key = String(body.r2Key ?? body.r2_key ?? "").trim();

    const limit = normalizeLimit(body.limit);
    const offset = normalizeOffset(body.offset);
    const onlyMissingDescription = body.onlyMissingDescription !== false;

    const rows = await loadRows({
      supabase,
      mediaContentAnalysisId,
      creatorId,
      r2Key,
      limit,
      offset,
      onlyMissingDescription,
    });

    const results: Array<{
      mediaContentAnalysisId: number;
      mediaFileId?: string | null;
      r2Key?: string | null;
      success: boolean;
      description?: string;
      error?: string;
    }> = [];

    for (const row of rows) {
      try {
        const result = await recalculateDescriptionForAnalysisRow({
          supabase,
          row,
        });

        results.push(result);
      } catch (error) {
        results.push({
          mediaContentAnalysisId: row.id,
          mediaFileId: row.media_file_id,
          r2Key: row.r2_key,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const successCount = results.filter((result) => result.success).length;
    const failureCount = results.length - successCount;

    return NextResponse.json({
      ok: true,
      success: failureCount === 0,
      requestedLimit: limit,
      offset,
      onlyMissingDescription,
      total: results.length,
      successCount,
      failureCount,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    console.error("[recalculate-description]", error);

    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: `Recalculate description error: ${message}`,
      },
      { status: 500 }
    );
  }
}