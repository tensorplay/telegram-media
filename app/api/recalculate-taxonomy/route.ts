// telegram-media/app/api/recalculate-taxonomy/route.ts

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSignedViewUrl } from "@/lib/r2";
import { runTaxonomyPipeline } from "@/lib/media-analysis/run-taxonomy-pipeline";
import { persistTaxonomyResults } from "@/lib/media-analysis/persist-taxonomy-results";
import {
  recalculateDescriptionForAnalysisRow,
  type AnalysisRow,
} from "@/lib/media-analysis/services/recalculate-description-service";
import { linkOnlyFansBundleItemsToAnalysis } from "@/lib/media-analysis/services/link-onlyfans-bundle-items";
import {
  prepareVideoForAnalysis,
  type PreparedVideoForAnalysis,
} from "@/lib/media-analysis/video/prepare-video-for-analysis";

export const maxDuration = 300;

type SupabaseClient =
  | Awaited<ReturnType<typeof createClient>>
  | ReturnType<typeof createAdminClient>;

type MediaRow = {
  id: string;
  creator_id: string;
  filename: string;
  r2_key: string;
  content_type: string;
  ai_summary: string | null;
  source?: "telegram" | "onlyfans";
};

type ExistingAnalysisRow = {
  id: number;
  creator_id: string | null;
  media_file_id: string;
  media_type: string;
  reference_name: string | null;
  r2_key: string;
  description: string | null;
  taxonomy: Record<string, unknown> | null;
};

function isInternalMediaApiRequest(request: NextRequest) {
  const internalApiKey = process.env.MEDIA_KEY || "";
  const requestApiKey = request.headers.get("x-api-key");

  return !!internalApiKey && requestApiKey === internalApiKey;
}

function getMediaType(contentType: string): "image" | "video" | "audio" {
  if (contentType.startsWith("video/")) {
    return "video";
  }

  if (contentType.startsWith("image/")) {
    return "image";
  }

  return "audio";
}

function getOnlyFansContentType(mediaType: string): string {
  const normalizedMediaType = String(mediaType || "").toLowerCase();

  if (normalizedMediaType === "video") return "video/mp4";
  if (normalizedMediaType === "photo") return "image/jpeg";
  if (normalizedMediaType === "gif") return "image/gif";
  if (normalizedMediaType === "audio") return "audio/mpeg";

  throw new Error(`Unsupported OnlyFans media_type "${mediaType}"`);
}

function getContentTypeFromAnalysisMediaType(mediaType: string): string {
  const normalizedMediaType = String(mediaType || "")
    .trim()
    .toLowerCase();

  if (normalizedMediaType === "video") {
    return "video/mp4";
  }

  if (
    normalizedMediaType === "image" ||
    normalizedMediaType === "photo"
  ) {
    return "image/jpeg";
  }

  if (normalizedMediaType === "gif") {
    return "image/gif";
  }

  if (normalizedMediaType === "audio") {
    return "audio/mpeg";
  }

  throw new Error(
    `Unsupported media_content_analysis.media_type "${mediaType}"`
  );
}

function getOnlyFansR2SessionName(sessionName: string): string {
  return String(sessionName || "").trim().replace(/\s+/g, "_");
}

function getOnlyFansR2Key(sessionName: string, mediaId: string, mediaType: string): string {
  const normalizedMediaType = String(mediaType || "").toLowerCase();
  const r2SessionName = getOnlyFansR2SessionName(sessionName);

  if (normalizedMediaType === "video") {
    return `vault/${r2SessionName}/${mediaId}/source.mp4`;
  }

  if (normalizedMediaType === "photo") {
    return `vault/${r2SessionName}/${mediaId}/source.jpg`;
  }

  if (normalizedMediaType === "gif") {
    return `vault/${r2SessionName}/${mediaId}/source.gif`;
  }

  if (normalizedMediaType === "audio") {
    return `vault/${r2SessionName}/${mediaId}/source.mp3`;
  }

  throw new Error(
    `Unsupported OnlyFans media_type "${mediaType}" for vault/${r2SessionName}/${mediaId}/`
  );
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

function normalizeMediaContentAnalysisIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  ).slice(0, 100);
}

// A0: a persisted domain only counts as "already done" (and therefore skippable
// on a non-forced re-run) when it carries real signal - any confirmed/probable
// tag or a non-empty justification. Failed video passes persist as empty arrays
// with a null justification; those must NOT be skipped, or they can never be
// recovered without force.
function taxonomyEntryHasSignal(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }

  const e = entry as Record<string, unknown>;
  const ar =
    e.analysis_result &&
    typeof e.analysis_result === "object" &&
    !Array.isArray(e.analysis_result)
      ? (e.analysis_result as Record<string, unknown>)
      : {};

  const confirmed = Array.isArray(e.confirmed)
    ? e.confirmed
    : Array.isArray(ar.confirmed)
      ? ar.confirmed
      : [];

  const probable = Array.isArray(e.probable)
    ? e.probable
    : Array.isArray(ar.probable)
      ? ar.probable
      : [];

  const justification =
    typeof e.justification === "string"
      ? e.justification
      : typeof ar.justification === "string"
        ? ar.justification
        : "";

  return (
    confirmed.length > 0 ||
    probable.length > 0 ||
    justification.trim().length > 0
  );
}

function getExistingTaxonomyKeys(
  taxonomy: Record<string, unknown> | null | undefined
): string[] {
  if (!taxonomy || typeof taxonomy !== "object" || Array.isArray(taxonomy)) {
    return [];
  }

  return Object.keys(taxonomy)
    .filter((key) =>
      taxonomyEntryHasSignal((taxonomy as Record<string, unknown>)[key])
    )
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean);
}

// A1: detect whether a freshly-run task produced real signal. Large videos sent
// inline to the provider can come back empty (no confirmed/probable, null
// justification); such results must not be treated as a successful analysis.
function taskResultHasSignal(task: { result?: unknown }): boolean {
  const r =
    task?.result &&
    typeof task.result === "object" &&
    !Array.isArray(task.result)
      ? (task.result as Record<string, unknown>)
      : {};

  const confirmed = Array.isArray(r.confirmed) ? r.confirmed : [];
  const probable = Array.isArray(r.probable) ? r.probable : [];
  const justification =
    typeof r.justification === "string" ? r.justification : "";

  return (
    confirmed.length > 0 ||
    probable.length > 0 ||
    justification.trim().length > 0
  );
}

type FetchedMedia = {
  mediaBytes: Buffer;
  mediaUrl: string;
};

async function fetchMedia(r2Key: string): Promise<FetchedMedia> {
  const mediaUrl = await getSignedViewUrl(r2Key, 600);

  const response = await fetch(mediaUrl, {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch media from R2: ${response.status}`);
  }

  return {
    mediaBytes: Buffer.from(await response.arrayBuffer()),
    mediaUrl,
  };
}

async function loadMediaById(
  supabase: SupabaseClient,
  mediaId: string
): Promise<MediaRow | null> {
  const { data, error } = await supabase
    .from("media_files")
    .select("id, creator_id, filename, r2_key, content_type, ai_summary")
    .eq("id", mediaId)
    .maybeSingle<MediaRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function loadMediaByAnalysisIds({
  supabase,
  analysisIds,
}: {
  supabase: SupabaseClient;
  analysisIds: number[];
}): Promise<MediaRow[]> {
  const { data, error } = await supabase
    .from("media_content_analysis")
    .select(`
      id,
      creator_id,
      media_file_id,
      media_type,
      reference_name,
      r2_key,
      description,
      taxonomy
    `)
    .in("id", analysisIds);

  if (error) {
    throw new Error(error.message);
  }

  const analyses = (data ?? []) as ExistingAnalysisRow[];

  const analysesById = new Map(
    analyses.map((analysis) => [Number(analysis.id), analysis])
  );

  const missingAnalysisIds = analysisIds.filter(
    (analysisId) => !analysesById.has(analysisId)
  );

  if (missingAnalysisIds.length > 0) {
    throw new Error(
      `media_content_analysis rows not found: ${missingAnalysisIds.join(", ")}`
    );
  }

  return analysisIds.map((analysisId) => {
    const analysis = analysesById.get(analysisId);

    if (!analysis) {
      throw new Error(
        `media_content_analysis row not found: ${analysisId}`
      );
    }

    const mediaFileId = String(
      analysis.media_file_id || ""
    ).trim();

    const r2Key = String(
      analysis.r2_key || ""
    ).trim();

    if (!mediaFileId) {
      throw new Error(
        `media_content_analysis ${analysisId} has no media_file_id`
      );
    }

    if (!r2Key) {
      throw new Error(
        `media_content_analysis ${analysisId} has no r2_key`
      );
    }

    return {
      id: mediaFileId,
      creator_id: String(
        analysis.creator_id || ""
      ).trim(),
      filename:
        String(analysis.reference_name || "").trim() ||
        r2Key.split("/").pop() ||
        `analysis_${analysisId}`,
      r2_key: r2Key,
      content_type: getContentTypeFromAnalysisMediaType(
        analysis.media_type
      ),
      ai_summary: null,
      source: r2Key.startsWith("vault/")
        ? ("onlyfans" as const)
        : ("telegram" as const),
    };
  });
}

async function loadMediaByCreatorId({
  supabase,
  creatorId,
  limit,
  offset,
  onlyMissingAnalysis,
}: {
  supabase: SupabaseClient;
  creatorId: string;
  limit: number;
  offset: number;
  onlyMissingAnalysis: boolean;
}): Promise<MediaRow[]> {
  const { data: mediaRows, error: mediaError } = await supabase
    .from("media_files")
    .select("id, creator_id, filename, r2_key, content_type, ai_summary")
    .eq("creator_id", creatorId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (mediaError) {
    throw new Error(mediaError.message);
  }

  const rows = mediaRows ?? [];

  if (!onlyMissingAnalysis || rows.length === 0) {
    return rows;
  }

  const mediaIds = rows.map((row) => row.id);

  const { data: existingAnalyses, error: existingError } = await supabase
    .from("media_content_analysis")
    .select("media_file_id")
    .in("media_file_id", mediaIds);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const analyzedIds = new Set(
    (existingAnalyses ?? [])
      .map((row) => String(row.media_file_id || ""))
      .filter(Boolean)
  );

  return rows.filter((row) => !analyzedIds.has(row.id));
}

async function loadOnlyFansVaultMediaBySessionName({
  supabase,
  sessionName,
  ofCreatorId,
  limit,
  offset,
  onlyMissingAnalysis,
}: {
  supabase: SupabaseClient;
  sessionName: string;
  ofCreatorId: string;
  limit: number;
  offset: number;
  onlyMissingAnalysis: boolean;
}): Promise<{ rows: MediaRow[]; scannedCount: number }> {
  const mapVaultRowToMediaRow = (row: any): MediaRow => {
    const mediaId = String(row.media_id || "").trim();
    const mediaType = String(row.media_type || "").toLowerCase();

    return {
      /**
       * IMPORTANT:
       *
       * Telegram:
       *   media_content_analysis.media_file_id -> media_files.id (UUID)
       *
       * OnlyFans:
       *   media_content_analysis.media_file_id -> vault_media.id (UUID)
       *
       * We must NOT use vault_media.media_id here because it is the
       * numeric OnlyFans media identifier (e.g. 3129108734) and
       * media_content_analysis.media_file_id expects a UUID.
       */
      id: String(row.id),

      creator_id: ofCreatorId,

      /**
       * Preserve the original OnlyFans media id in the filename.
       */
      filename: `${sessionName}/${mediaId}`,

      r2_key: getOnlyFansR2Key(sessionName, mediaId, mediaType),
      content_type: getOnlyFansContentType(mediaType),
      ai_summary: null,
      source: "onlyfans" as const,
    };
  };

  if (!onlyMissingAnalysis) {
    const { data: vaultRows, error: vaultError } = await supabase
      .from("vault_media")
      .select(`
        id,
        session_name,
        media_id,
        media_type,
        duration,
        created_at,
        created_at_of
      `)
      .eq("session_name", sessionName)
      .order("media_id", { ascending: true })
      .range(offset, offset + limit - 1);

    if (vaultError) {
      throw new Error(vaultError.message);
    }

    const rows = (vaultRows ?? []).map(mapVaultRowToMediaRow);

    return {
      rows,
      scannedCount: rows.length,
    };
  }

  /**
   * ONLY_MISSING_ANALYSIS mode:
   *
   * Prioritize media that is already used in bundles but whose bundle_item is not
   * linked to media_content_analysis yet. This makes recalculate-taxonomy unlock
   * the Sellable Library / bundle flow first instead of spending batches on random
   * vault_media that is not currently used by any bundle.
   *
   * Important:
   * - We intentionally do not apply the external offset to the missing queue.
   *   The missing queue shrinks as rows get analyzed/linked, so offset-based
   *   pagination can skip work. Taking the first N missing candidates each run is
   *   safer for a retry queue.
   * - After bundled candidates, we fill the batch with normal vault_media.
   */
  const maxCandidateCount = Math.min(Math.max(limit * 20, 100), 1000);

  const { data: bundleRows, error: bundleError } = await supabase
    .from("bundles")
    .select("id")
    .eq("session_name", sessionName);

  if (bundleError) {
    throw new Error(bundleError.message);
  }

  const bundleIds = (bundleRows ?? [])
    .map((row: any) => String(row.id || "").trim())
    .filter(Boolean);

  let prioritizedMediaIds: string[] = [];

  if (bundleIds.length > 0) {
    const { data: bundleItemRows, error: bundleItemError } = await supabase
      .from("bundle_items")
      .select("media_id")
      .in("bundle_id", bundleIds)
      .is("media_content_analysis_id", null)
      .not("media_id", "is", null)
      .limit(maxCandidateCount);

    if (bundleItemError) {
      throw new Error(bundleItemError.message);
    }

    prioritizedMediaIds = Array.from(
      new Set(
        (bundleItemRows ?? [])
          .map((row: any) => String(row.media_id || "").trim())
          .filter(Boolean)
      )
    );
  }

  const candidateVaultRows: any[] = [];
  const candidateMediaIds = new Set<string>();

  const addCandidateRows = (rows: any[] | null | undefined) => {
    for (const row of rows ?? []) {
      const mediaId = String(row.media_id || "").trim();

      if (!mediaId || candidateMediaIds.has(mediaId)) {
        continue;
      }

      candidateMediaIds.add(mediaId);
      candidateVaultRows.push(row);
    }
  };

  if (prioritizedMediaIds.length > 0) {
    const { data: prioritizedVaultRows, error: prioritizedVaultError } =
      await supabase
        .from("vault_media")
        .select(`
          id,
          session_name,
          media_id,
          media_type,
          duration,
          created_at,
          created_at_of
        `)
        .eq("session_name", sessionName)
        .in("media_id", prioritizedMediaIds)
        .order("media_id", { ascending: true })
        .limit(maxCandidateCount);

    if (prioritizedVaultError) {
      throw new Error(prioritizedVaultError.message);
    }

    addCandidateRows(prioritizedVaultRows);
  }

  if (candidateVaultRows.length < maxCandidateCount) {
    const { data: fallbackVaultRows, error: fallbackVaultError } =
      await supabase
        .from("vault_media")
        .select(`
          id,
          session_name,
          media_id,
          media_type,
          duration,
          created_at,
          created_at_of
        `)
        .eq("session_name", sessionName)
        .order("media_id", { ascending: true })
        .limit(maxCandidateCount);

    if (fallbackVaultError) {
      throw new Error(fallbackVaultError.message);
    }

    addCandidateRows(fallbackVaultRows);
  }

  const rows = candidateVaultRows.map(mapVaultRowToMediaRow);

  if (rows.length === 0) {
    return {
      rows: [],
      scannedCount: 0,
    };
  }

  const r2Keys = rows.map((row) => row.r2_key);

  const { data: existingAnalyses, error: existingError } = await supabase
    .from("media_content_analysis")
    .select("id, media_file_id, r2_key, description")
    .in("r2_key", r2Keys);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const existingByR2Key = new Map(
    (existingAnalyses ?? []).map((row: any) => [
      String(row.r2_key || ""),
      row,
    ])
  );

  const rowsToProcess: MediaRow[] = [];

  for (const row of rows) {
    const existing = existingByR2Key.get(row.r2_key);

    if (existing?.id && existing?.media_file_id) {
      await linkOnlyFansBundleItemsToAnalysis({
        supabase,
        mediaFileId: String(existing.media_file_id),
        analysisId: Number(existing.id),
      });
    }

    if (!existing || !existing.description) {
      rowsToProcess.push(row);
    }

    if (rowsToProcess.length >= limit) {
      break;
    }
  }

  return {
    rows: rowsToProcess,
    scannedCount: rows.length,
  };
}

async function loadExistingAnalysisByHash(
  supabase: SupabaseClient,
  originalFileHash: string
): Promise<ExistingAnalysisRow | null> {
  const { data, error } = await supabase
    .from("media_content_analysis")
    .select("id, taxonomy")
    .eq("original_file_hash", originalFileHash)
    .maybeSingle<ExistingAnalysisRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function recalculateTaxonomyForMedia({
  supabase,
  media,
  force,
  calculateDescription,
}: {
  supabase: SupabaseClient;
  media: MediaRow;
  force: boolean;
  calculateDescription: boolean;
}) {
  if (!media.r2_key) {
    throw new Error("Media has no r2_key");
  }

  if (!media.content_type) {
    throw new Error("Media has no content_type");
  }

  const { mediaBytes, mediaUrl: originalMediaUrl } = await fetchMedia(
    media.r2_key
  );

  const originalFileHash = createHash("sha256")
    .update(mediaBytes)
    .digest("hex");

  let preparedVideo: PreparedVideoForAnalysis | null = null;

  try {
    if (media.content_type.startsWith("video/")) {
      preparedVideo = await prepareVideoForAnalysis({
        mediaBytes,
        mimeType: media.content_type,
        originalMediaUrl,
        filename: media.filename || "source.mp4",
        maxSizeMB: 10,
        targetSizeMB: 9.5,
        logTag: "TAXONOMY_VIDEO",
      });
    }

    const analysisMediaUrl =
      preparedVideo?.mediaUrl ?? originalMediaUrl;

    const analysisMediaBytes =
      preparedVideo?.mediaBytes ?? mediaBytes;

    console.log("[recalculate-taxonomy][prepared-media]", {
      mediaId: media.id,
      contentType: media.content_type,
      originalBytes: mediaBytes.length,
      mediaUrlWasPrepared: Boolean(preparedVideo),
      wasCompressed: preparedVideo?.wasCompressed ?? false,
      processedBytes: preparedVideo?.processedBytes ?? mediaBytes.length,
    });

    const existingAnalysis = await loadExistingAnalysisByHash(
      supabase,
      originalFileHash
    );

    const existingTaxonomyKeys = getExistingTaxonomyKeys(
      existingAnalysis?.taxonomy
    );

    const taxonomyPipelineResult = await runTaxonomyPipeline({
      mediaBytes: analysisMediaBytes,
      mediaUrl: analysisMediaUrl,
      contentType: media.content_type,
      skipTaskKeys: force ? [] : existingTaxonomyKeys,
    });

    const mediaType = getMediaType(media.content_type);

    // A1: did this run actually produce usable taxonomy? Either a freshly-run task
    // returned signal, or every task was skipped because the existing row was
    // already good (non-degenerate, see getExistingTaxonomyKeys).
    const producedSignal = taxonomyPipelineResult.tasks.some(taskResultHasSignal);
    const hadUsableExisting = existingTaxonomyKeys.length > 0;
    const taxonomyIsUsable = producedSignal || hadUsableExisting;

    // Only mark COMPLETED when taxonomy is genuinely usable. A video/provider pass
    // that yields no signal is not "done"; mark it FAILED so it remains retriable
    // instead of being silently treated as completed.
    const moderationStatus: "PENDING" | "COMPLETED" | "FAILED" = taxonomyIsUsable
      ? "COMPLETED"
      : "FAILED";

    await persistTaxonomyResults({
      creatorId: media.creator_id,
      mediaFileId: media.id,
      r2Key: media.r2_key,
      originalFileHash,
      mediaType,
      referenceName: media.filename || media.id,
      description: undefined,
      isSexual: taxonomyPipelineResult.isSexual,
      moderationStatus,
      moderation: {},
      durationSeconds: null,
      descriptionEmbedding: null,
      mediaEmbedding: null,
      tasks: taxonomyPipelineResult.tasks,
      // Don't synthesize EXPLICIT_LEVEL=NONE for a failed/empty run (it would make
      // the row look non-empty and defeat the A0 degeneracy check).
      highestExplicitnessLevel: producedSignal
        ? (taxonomyPipelineResult.highestExplicitnessLevel ?? "NONE")
        : null,
    });

    // Surface empty results as a retriable failure (A0 keeps the row reprocessable).
    if (!taxonomyIsUsable) {
      throw new Error(
        `Taxonomy produced no signal for ${mediaType} media ${media.id} ` +
          `(likely a provider/media limitation - marked FAILED for retry)`
      );
    }

    const {
      data: persistedAnalysis,
      error: persistedAnalysisError,
    } = await supabase
      .from("media_content_analysis")
      .select("id, media_file_id")
      .eq("original_file_hash", originalFileHash)
      .maybeSingle<{ id: number; media_file_id: string }>();

    if (persistedAnalysisError) {
      throw new Error(persistedAnalysisError.message);
    }

    if (media.source === "onlyfans" && persistedAnalysis?.id) {
      await linkOnlyFansBundleItemsToAnalysis({
        supabase,
        mediaFileId: media.id,
        analysisId: persistedAnalysis.id,
      });
    }

    let descriptionResult: Awaited<
      ReturnType<typeof recalculateDescriptionForAnalysisRow>
    > | null = null;

    if (calculateDescription) {
      console.log("[recalculate-taxonomy][description] enabled", {
        mediaId: media.id,
        originalFileHash,
      });

      const { data: analysisRow, error: analysisRowError } =
        await supabase
          .from("media_content_analysis")
          .select(
            "id, media_file_id, r2_key, media_type, description, taxonomy"
          )
          .eq("original_file_hash", originalFileHash)
          .maybeSingle<AnalysisRow>();

      if (analysisRowError) {
        throw new Error(analysisRowError.message);
      }

      if (!analysisRow) {
        throw new Error(
          "Could not load media_content_analysis row after taxonomy persistence"
        );
      }

      const hasUsableTaxonomy =
        analysisRow.taxonomy &&
        typeof analysisRow.taxonomy === "object" &&
        !Array.isArray(analysisRow.taxonomy) &&
        Object.keys(analysisRow.taxonomy).length > 0;

      if (!hasUsableTaxonomy) {
        console.warn(
          "[recalculate-taxonomy][description] skipped: missing taxonomy",
          {
            mediaId: media.id,
            analysisId: analysisRow.id,
            r2Key: analysisRow.r2_key,
          }
        );
      } else if (force || !analysisRow.description) {
        console.log("[recalculate-taxonomy][description] calculating", {
          mediaId: media.id,
          analysisId: analysisRow.id,
          r2Key: analysisRow.r2_key,
          force,
          hadExistingDescription: Boolean(analysisRow.description),
        });

        descriptionResult =
          await recalculateDescriptionForAnalysisRow({
            supabase,
            row: analysisRow,
            preparedMedia: {
              mediaBytes: analysisMediaBytes,
              mediaUrl: analysisMediaUrl,
              contentType: media.content_type,
            },
          });
      }
    }

    return {
      mediaId: media.id,
      originalFileHash,
      force,
      existingAnalysisId: existingAnalysis?.id ?? null,
      descriptionResult,
      existingTaxonomyKeyCount: existingTaxonomyKeys.length,
      taskCount: taxonomyPipelineResult.tasks.length,
      executedTaskKeys: taxonomyPipelineResult.executedTaskKeys,
      skippedTaskKeys: taxonomyPipelineResult.skippedTaskKeys,
      isSexual: taxonomyPipelineResult.isSexual,
      highestExplicitnessLevel:
        taxonomyPipelineResult.highestExplicitnessLevel ?? null,
    };
  } finally {
    await preparedVideo?.cleanup();
  }
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

    const mediaContentAnalysisIds =
      normalizeMediaContentAnalysisIds(
        body.mediaContentAnalysisIds ??
          body.media_content_analysis_ids
      );

    const mediaId = String(
      body.mediaId ??
        body.media_id ??
        body.mediaFileId ??
        body.media_file_id ??
        ""
    ).trim();

    const creatorId = String(body.creatorId ?? body.creator_id ?? "").trim();

    const source = String(body.source ?? "telegram").trim().toLowerCase();
    const sessionName = String(body.sessionName ?? body.session_name ?? "").trim();
    const ofCreatorId = String(body.ofCreatorId ?? body.of_creator_id ?? "").trim();

    const limit = normalizeLimit(body.limit);
    const offset = normalizeOffset(body.offset);
    const onlyMissingAnalysis = body.onlyMissingAnalysis === true;
    const force = body.force === true;
    const calculateDescription = body.calculateDescription === true;    

    if (mediaContentAnalysisIds.length === 0) {
      if (source === "onlyfans") {
        if (!sessionName || !ofCreatorId) {
          return NextResponse.json(
            {
              error:
                "Missing sessionName or ofCreatorId for onlyfans source",
            },
            { status: 400 }
          );
        }
      } else if (!mediaId && !creatorId) {
        return NextResponse.json(
          {
            error:
              "Missing mediaContentAnalysisIds, mediaId or creatorId",
          },
          { status: 400 }
        );
      }
    }

    const mediaRows: MediaRow[] = [];

    let scannedCount = 0;

    if (mediaContentAnalysisIds.length > 0) {
      const rows = await loadMediaByAnalysisIds({
        supabase,
        analysisIds: mediaContentAnalysisIds,
      });

      scannedCount = rows.length;
      mediaRows.push(...rows);
    } else if (source === "onlyfans") {
      const result = await loadOnlyFansVaultMediaBySessionName({
        supabase,
        sessionName,
        ofCreatorId,
        limit,
        offset,
        onlyMissingAnalysis,
      });

      scannedCount = result.scannedCount;
      mediaRows.push(...result.rows);
    } else if (mediaId) {
      const media = await loadMediaById(supabase, mediaId);

      if (!media) {
        return NextResponse.json(
          { error: "Media not found" },
          { status: 404 }
        );
      }

      scannedCount = 1;
      mediaRows.push(media);
    } else {
      const rows = await loadMediaByCreatorId({
        supabase,
        creatorId,
        limit,
        offset,
        onlyMissingAnalysis,
      });

      scannedCount = rows.length;
      mediaRows.push(...rows);
    }

    const results: Array<{
      mediaId: string;
      success: boolean;
      originalFileHash?: string;
      force?: boolean;
      existingAnalysisId?: number | null;
      descriptionResult?: Awaited<
        ReturnType<typeof recalculateDescriptionForAnalysisRow>
      > | null;
      existingTaxonomyKeyCount?: number;
      taskCount?: number;
      executedTaskKeys?: string[];
      skippedTaskKeys?: string[];
      isSexual?: boolean;
      highestExplicitnessLevel?: string | null;
      error?: string;
    }> = [];

    for (const media of mediaRows) {
      try {
        const result = await recalculateTaxonomyForMedia({
          supabase,
          media,
          force,
          calculateDescription,
        });

        results.push({
          success: true,
          ...result,
        });
      } catch (error) {
        results.push({
          mediaId: media.id,
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
      mode:
        mediaContentAnalysisIds.length > 0
          ? "media_content_analysis_ids_batch"
          : source === "onlyfans"
            ? "onlyfans_vault_batch"
            : mediaId
              ? "single_media"
              : "creator_media_batch",
      source,
      mediaContentAnalysisIds,
      creatorId:
        source === "onlyfans"
          ? ofCreatorId
          : creatorId || null,
      sessionName: sessionName || null,
      ofCreatorId: ofCreatorId || null,
      mediaId: mediaId || null,
      requestedLimit: limit,
      offset,
      onlyMissingAnalysis,
      force,
      calculateDescription,
      scannedCount,
      total: results.length,
      successCount,
      failureCount,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    console.error("[recalculate-taxonomy]", error);

    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: `Recalculate taxonomy error: ${message}`,
      },
      { status: 500 }
    );
  }
}