// lib/media-analysis/persist-taxonomy-results.ts

import { createClient } from "@/lib/supabase/server";
import type { TaxonomyTaskResult } from "@/lib/media-analysis/run-taxonomy-analysis";

type MediaContentAnalysisRow = {
  id: number;
  taxonomy: Record<string, unknown> | null;
};

export type PersistTaxonomyResultsInput = {
  creatorId?: string | null;
  originalFileHash: string;
  mediaFileId?: string | null;
  r2Key?: string | null;
  mediaType: "video" | "image" | "audio";
  referenceName: string;
  description?: string | null;
  isSexual?: boolean;
  moderationStatus?: "PENDING" | "COMPLETED" | "FAILED";
  moderation?: Record<string, unknown>;
  durationSeconds?: number | null;
  descriptionEmbedding?: number[] | null;
  mediaEmbedding?: number[] | null;
  tasks: TaxonomyTaskResult[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidSha256(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function mergeTaxonomy(
  existingTaxonomy: Record<string, unknown> | null | undefined,
  taxonomyUpdates: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return {
    ...(isPlainObject(existingTaxonomy) ? existingTaxonomy : {}),
    ...(isPlainObject(taxonomyUpdates) ? taxonomyUpdates : {}),
  };
}

function normalizeCategoriesFromTaskResult(task: TaxonomyTaskResult): {
  justification: string | null;
  confirmed: string[];
  probable: string[];
  raw: Record<string, unknown>;
} {
  const analysisResult =
    task.result && typeof task.result === "object" && !Array.isArray(task.result)
      ? (task.result as Record<string, unknown>)
      : {};

  const confirmed = Array.isArray(analysisResult.confirmed)
    ? analysisResult.confirmed
    : [];

  const probable = Array.isArray(analysisResult.probable)
    ? analysisResult.probable
    : [];

  const justification =
    typeof analysisResult.justification === "string"
      ? analysisResult.justification
      : null;

  return {
    justification,
    confirmed: confirmed
      .map((value) => String(value).trim().toUpperCase())
      .filter(Boolean),
    probable: probable
      .map((value) => String(value).trim().toUpperCase())
      .filter(Boolean),
    raw: analysisResult,
  };
}

function buildTaxonomyDomainKey(
  parentDomain: string,
  childDomain: string
): string {
  return `${String(parentDomain).trim().toUpperCase()}:${String(childDomain)
    .trim()
    .toUpperCase()}`;
}

function buildTaxonomyEntry(task: TaxonomyTaskResult): Record<string, unknown> {
  const normalized = normalizeCategoriesFromTaskResult(task);

  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: "upload-analyze",
    status: "completed",
    parent_domain: task.taxonomyDomain,
    child_domain: task.parentCategory,
    return_summary_format: task.taskFormat,
    justification: normalized.justification,
    confirmed: normalized.confirmed,
    probable: normalized.probable,
    analysis_result: normalized.raw,
  };
}

function buildTaxonomyUpdates(tasks: TaxonomyTaskResult[]): Record<string, unknown> {
  const updates: Record<string, unknown> = {};

  for (const task of tasks) {
    const key = buildTaxonomyDomainKey(
      task.taxonomyDomain,
      task.parentCategory
    );

    updates[key] = buildTaxonomyEntry(task);
  }

  return updates;
}

/**
 * Persists taxonomy task results into public.media_content_analysis.
 *
 * Behavior:
 * - finds an existing row by original_file_hash
 * - inserts a new row if not found
 * - otherwise merges taxonomy updates into the existing taxonomy jsonb field
 *
 * This function only persists the new taxonomy analysis layer.
 * It does not replace the current media_files ai_summary / ai_tags flow.
 */
export async function persistTaxonomyResults(
  input: PersistTaxonomyResultsInput
): Promise<void> {
  const {
    creatorId = null,
    mediaFileId = null,
    r2Key = null,
    originalFileHash,
    mediaType,
    referenceName,
    description = null,
    isSexual = false,
    moderationStatus = "PENDING",
    moderation = {},
    durationSeconds = null,
    descriptionEmbedding = null,
    mediaEmbedding = null,
    tasks,
  } = input;

  if (!isValidSha256(originalFileHash)) {
    throw new Error('persistTaxonomyResults: "originalFileHash" must be a valid SHA-256 hex string');
  }

  if (!referenceName.trim()) {
    throw new Error('persistTaxonomyResults: "referenceName" is required');
  }

  if (!tasks.length) {
    return;
  }

  const supabase = await createClient();
  const taxonomyUpdates = buildTaxonomyUpdates(tasks);

  const { data: existingRow, error: existingError } = await supabase
    .from("media_content_analysis")
    .select("id, taxonomy")
    .eq("original_file_hash", originalFileHash)
    .maybeSingle<MediaContentAnalysisRow>();

  if (existingError) {
    throw new Error(
      `persistTaxonomyResults: failed to load existing row: ${existingError.message}`
    );
  }

  if (!existingRow) {
    const { error: insertError } = await supabase
      .from("media_content_analysis")
      .insert({
        creator_id: creatorId,
        media_file_id: mediaFileId,
        r2_key: r2Key,
        original_file_hash: originalFileHash,
        media_type: mediaType,
        reference_name: referenceName,
        description,
        is_sexual: isSexual,
        moderation_status: moderationStatus,
        moderation,
        taxonomy: taxonomyUpdates,
        duration_seconds: durationSeconds,
        description_embedding: descriptionEmbedding,
        media_embedding: mediaEmbedding,
      });

    if (insertError) {
      throw new Error(
        `persistTaxonomyResults: failed to insert media_content_analysis: ${insertError.message}`
      );
    }

    return;
  }

  const mergedTaxonomy = mergeTaxonomy(existingRow.taxonomy, taxonomyUpdates);

  const { error: updateError } = await supabase
    .from("media_content_analysis")
    .update({
      creator_id: creatorId,
      media_file_id: mediaFileId,
      r2_key: r2Key,
      media_type: mediaType,
      reference_name: referenceName,
      description,
      is_sexual: isSexual,
      moderation_status: moderationStatus,
      moderation,
      taxonomy: mergedTaxonomy,
      duration_seconds: durationSeconds,
      description_embedding: descriptionEmbedding,
      media_embedding: mediaEmbedding,
    })
    .eq("id", existingRow.id);

  if (updateError) {
    throw new Error(
      `persistTaxonomyResults: failed to update media_content_analysis: ${updateError.message}`
    );
  }
}