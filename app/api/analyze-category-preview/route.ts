import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSignedViewUrl } from "@/lib/r2";
import { runTaxonomyTask } from "@/lib/media-analysis/run-taxonomy-analysis";
import { parseTaskFormat } from "@/lib/media-analysis/task-format";
import {
  normalizeTaskFormat,
  validateTaxonomyTaskFormat,
} from "@/lib/media-analysis/taxonomy-category-options";

export const maxDuration = 120;

type SupabaseClient =
  | Awaited<ReturnType<typeof createClient>>
  | ReturnType<typeof createAdminClient>;

type MediaRow = {
  id: string;
  creator_id: string | null;
  filename: string | null;
  r2_key: string;
  content_type: string;
  ai_summary: string | null;
};

type AnalysisMediaRow = {
  id: string;
  creator_id: string | null;
  media_file_id: string | null;
  media_type: string | null;
  reference_name: string | null;
  r2_key: string | null;
  description: string | null;
};

function isInternalMediaApiRequest(request: NextRequest) {
  const internalApiKey = process.env.MULTIPLATFORM_MEDIA_API_KEY || "";
  const requestApiKey = request.headers.get("x-api-key");

  return !!internalApiKey && requestApiKey === internalApiKey;
}

function getApiKeyDebug(request: NextRequest) {
  const internalApiKey = process.env.MULTIPLATFORM_MEDIA_API_KEY || "";
  const requestApiKey = request.headers.get("x-api-key");

  return {
    hasExpectedApiKey: Boolean(internalApiKey),
    hasRequestApiKey: Boolean(requestApiKey),
    expectedApiKeyPrefix: internalApiKey ? internalApiKey.slice(0, 6) : null,
    requestApiKeyPrefix: requestApiKey ? requestApiKey.slice(0, 6) : null,
    keysMatch: Boolean(internalApiKey && requestApiKey === internalApiKey),
  };
}

async function resolveMediaIdFromAnalysisId(
  supabase: SupabaseClient,
  mediaContentAnalysisId: string
): Promise<string | null> {
  console.log("[telegram-medai][resolveMediaId] start", {
    mediaContentAnalysisId,
    supabaseUrlHost: (() => {
      try {
        return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").host;
      } catch {
        return null;
      }
    })(),
    hasAnonKey: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });

  const { data, error, status, statusText } = await supabase
    .from("media_content_analysis")
    .select("id, media_file_id")
    .eq("id", mediaContentAnalysisId)
    .maybeSingle();

  console.log("[telegram-medai][resolveMediaId] result", {
    mediaContentAnalysisId,
    status,
    statusText,
    hasData: Boolean(data),
    data,
    errorMessage: error?.message ?? null,
    errorCode: error?.code ?? null,
    errorDetails: error?.details ?? null,
    errorHint: error?.hint ?? null,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data?.media_file_id ?? null;
}

async function loadMedia(
  supabase: SupabaseClient,
  mediaId: string
): Promise<MediaRow | null> {
  const normalizedMediaId = String(mediaId || "").trim();

  console.log("[telegram-medai][loadMedia] start", {
    mediaId,
    normalizedMediaId,
    mediaIdLength: normalizedMediaId.length,
    looksLikeUuid:
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        normalizedMediaId
      ),
    supabaseUrlHost: (() => {
      try {
        return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").host;
      } catch {
        return null;
      }
    })(),
    hasAnonKey: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });

  const { data, error, status, statusText } = await supabase
    .from("media_files")
    .select("id, creator_id, filename, r2_key, content_type, ai_summary")
    .eq("id", normalizedMediaId)
    .maybeSingle<MediaRow>();

  console.log("[telegram-medai][loadMedia] maybeSingle result", {
    mediaId: normalizedMediaId,
    status,
    statusText,
    hasData: Boolean(data),
    dataPreview: data
      ? {
          id: data.id,
          creator_id: data.creator_id,
          filename: data.filename,
          r2_key: data.r2_key,
          content_type: data.content_type,
          hasAiSummary: Boolean(data.ai_summary),
        }
      : null,
    errorMessage: error?.message ?? null,
    errorCode: error?.code ?? null,
    errorDetails: error?.details ?? null,
    errorHint: error?.hint ?? null,
  });

  const {
    count,
    error: countError,
    status: countStatus,
    statusText: countStatusText,
  } = await supabase
    .from("media_files")
    .select("id", {
      count: "exact",
      head: true,
    })
    .eq("id", normalizedMediaId);

  console.log("[telegram-medai][loadMedia] count result", {
    mediaId: normalizedMediaId,
    count,
    countStatus,
    countStatusText,
    countErrorMessage: countError?.message ?? null,
    countErrorCode: countError?.code ?? null,
    countErrorDetails: countError?.details ?? null,
    countErrorHint: countError?.hint ?? null,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function loadAnalysisMedia(
  supabase: SupabaseClient,
  mediaContentAnalysisId: string
): Promise<MediaRow | null> {
  const { data, error } = await supabase
    .from("media_content_analysis")
    .select("id, creator_id, media_file_id, media_type, reference_name, r2_key, description")
    .eq("id", mediaContentAnalysisId)
    .maybeSingle<AnalysisMediaRow>();

  if (error) {
    throw new Error(error.message);
  }

  if (!data?.r2_key) {
    return null;
  }

  const contentType =
    String(data.media_type || "").toLowerCase() === "video"
      ? "video/mp4"
      : "image/jpeg";

  return {
    id: data.media_file_id || data.id,
    creator_id: data.creator_id,
    filename: data.reference_name || data.media_file_id || data.id,
    r2_key: data.r2_key,
    content_type: contentType,
    ai_summary: data.description,
  };
}

async function fetchMediaBytes(r2Key: string): Promise<Buffer> {
  const signedUrl = await getSignedViewUrl(r2Key, 600);

  const response = await fetch(signedUrl, {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch media from R2: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function POST(request: NextRequest) {
  try {
    const sessionSupabase = await createClient();

    const {
      data: { user },
    } = await sessionSupabase.auth.getUser();

    const isInternalRequest = isInternalMediaApiRequest(request);

    const supabase = isInternalRequest
      ? createAdminClient()
      : sessionSupabase;

    console.log("[telegram-medai][analyze-category-preview] auth check", {
      hasUser: Boolean(user),
      isInternalRequest,
      usingAdminClient: isInternalRequest,
      ...getApiKeyDebug(request),
    });

    if (!user && !isInternalRequest) {
      console.warn("[telegram-medai][analyze-category-preview] unauthorized", {
        reason: "missing Supabase user and invalid or missing x-api-key",
        ...getApiKeyDebug(request),
      });

      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));

    console.log("[telegram-medai][analyze-category-preview] request body", {
      mediaContentAnalysisId:
        body.mediaContentAnalysisId ?? body.media_content_analysis_id ?? null,
      mediaId:
        body.mediaId ??
        body.media_id ??
        body.mediaFileId ??
        body.media_file_id ??
        null,
      taskFormat:
        body.taskFormat ??
        body.task_format ??
        body.category ??
        body.taxonomyCategory ??
        null,
      creatorId: body.creatorId ?? body.creator_id ?? null,
      hasLlm: Boolean(body.llm),
      llmProvider: body.llm_provider ?? body.llm?.provider ?? null,
      llmModelName: body.llm_model_name ?? body.llm?.model ?? null,
    });

    const mediaContentAnalysisId = String(
      body.mediaContentAnalysisId ??
        body.media_content_analysis_id ??
        ""
    ).trim();

    let mediaId = String(
      body.mediaId ??
        body.media_id ??
        body.mediaFileId ??
        body.media_file_id ??
        ""
    ).trim();

    const taskFormat = normalizeTaskFormat(
      body.taskFormat ??
        body.task_format ??
        body.category ??
        body.taxonomyCategory
    );

    if (!mediaId && mediaContentAnalysisId) {
      console.log("[telegram-medai][analyze-category-preview] resolving media id", {
        mediaContentAnalysisId,
        usingAdminClient: isInternalRequest,
      });

      const resolvedMediaId = await resolveMediaIdFromAnalysisId(
        supabase,
        mediaContentAnalysisId
      );

      console.log("[telegram-medai][analyze-category-preview] resolved media id", {
        mediaContentAnalysisId,
        resolvedMediaId,
        usingAdminClient: isInternalRequest,
      });

      if (!resolvedMediaId) {
        return NextResponse.json(
          {
            ok: false,
            saved: false,
            error:
              "Could not resolve media_file_id from mediaContentAnalysisId",
          },
          { status: 400 }
        );
      }

      mediaId = resolvedMediaId;
    }

    if (!mediaId) {
      console.warn("[telegram-medai][analyze-category-preview] missing media id", {
        mediaContentAnalysisId,
      });

      return NextResponse.json(
        {
          ok: false,
          saved: false,
          error: "Missing mediaId or mediaContentAnalysisId",
        },
        { status: 400 }
      );
    }

    if (!taskFormat) {
      console.warn("[telegram-medai][analyze-category-preview] missing taskFormat", {
        mediaId,
        mediaContentAnalysisId,
      });

      return NextResponse.json(
        {
          ok: false,
          saved: false,
          error: "Missing taskFormat or category",
        },
        { status: 400 }
      );
    }

    console.log("[telegram-medai][analyze-category-preview] validating taxonomy task", {
      mediaId,
      mediaContentAnalysisId,
      taskFormat,
      usingAdminClient: isInternalRequest,
    });

    const validation = await validateTaxonomyTaskFormat({
      supabase,
      taskFormat,
    });

    console.log("[telegram-medai][analyze-category-preview] taxonomy validation result", {
      taskFormat,
      valid: validation.valid,
      error: validation.error,
      allowedTaskFormatsCount: validation.options.length,
      usingAdminClient: isInternalRequest,
    });

    if (!validation.valid) {
      return NextResponse.json(
        {
          ok: false,
          saved: false,
          error: validation.error,
          allowedTaskFormats: validation.options.map(
            (option) => option.taskFormat
          ),
          allowedCategories: validation.options,
        },
        { status: 400 }
      );
    }

    console.log("[telegram-medai][analyze-category-preview] loading media", {
      mediaId,
      authMode: isInternalRequest ? "internal_x_api_key" : "supabase_user",
      hasUser: Boolean(user),
      usingAdminClient: isInternalRequest,
    });

    let media = await loadMedia(supabase, mediaId);

    if (!media && mediaContentAnalysisId) {
      console.log("[telegram-medai][analyze-category-preview] media_files not found, trying analysis r2_key fallback", {
        mediaId,
        mediaContentAnalysisId,
      });

      media = await loadAnalysisMedia(supabase, mediaContentAnalysisId);
    }

    console.log("[telegram-medai][analyze-category-preview] media loaded", {
      mediaId,
      found: Boolean(media),
      creatorId: media?.creator_id ?? null,
      contentType: media?.content_type ?? null,
      hasR2Key: Boolean(media?.r2_key),
      filename: media?.filename ?? null,
      usingAdminClient: isInternalRequest,
    });

    if (!media) {
      return NextResponse.json(
        {
          ok: false,
          saved: false,
          error: "Media not found",
        },
        { status: 404 }
      );
    }

    if (!media.r2_key) {
      return NextResponse.json(
        {
          ok: false,
          saved: false,
          error: "Media has no r2_key",
        },
        { status: 400 }
      );
    }

    if (!media.content_type) {
      return NextResponse.json(
        {
          ok: false,
          saved: false,
          error: "Media has no content_type",
        },
        { status: 400 }
      );
    }

    console.log("[telegram-medai][analyze-category-preview] fetching media bytes", {
      mediaId,
      r2Key: media.r2_key,
      contentType: media.content_type,
    });

    const mediaBytes = await fetchMediaBytes(media.r2_key);

    const originalFileHash = createHash("sha256")
      .update(mediaBytes)
      .digest("hex");

    console.log("[telegram-medai][analyze-category-preview] media bytes fetched", {
      mediaId,
      bytes: mediaBytes.length,
      originalFileHash,
    });

    console.log("[telegram-medai][analyze-category-preview] running taxonomy task", {
      mediaId,
      taskFormat,
      contentType: media.content_type,
    });

    const taskResult = await runTaxonomyTask({
      taskFormat,
      mediaBytes,
      contentType: media.content_type,
    });

    const parsedTask = parseTaskFormat(taskFormat);
    const taxonomyKey = `${parsedTask.taxonomyDomain}:${parsedTask.parentCategory}`;

    console.log("[telegram-medai][analyze-category-preview] taxonomy task completed", {
      mediaId,
      taskFormat,
      taxonomyKey,
      hasResult: Boolean(taskResult?.result),
    });

    return NextResponse.json({
      ok: true,
      success: true,
      saved: false,
      mediaId: media.id,
      mediaContentAnalysisId: mediaContentAnalysisId || null,
      originalFileHash,
      taskFormat,
      taxonomyKey,
      taxonomyEntryPreview: {
        version: 1,
        source: "preview-analyze",
        status: "completed",
        parent_domain: parsedTask.taxonomyDomain,
        child_domain: parsedTask.parentCategory,
        return_summary_format: taskFormat,
        analysis_result: taskResult.result,
      },
      result: taskResult.result,
      taskResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    console.error("[telegram-medai][analyze-category-preview] error", {
      message,
      error,
    });

    return NextResponse.json(
      {
        ok: false,
        success: false,
        saved: false,
        error: `Analyze category preview error: ${message}`,
      },
      { status: 500 }
    );
  }
}