// lib/media-analysis/services/link-onlyfans-bundle-items.ts

export async function linkOnlyFansBundleItemsToAnalysis({
  supabase,
  mediaFileId,
  analysisId,
}: {
  supabase: any;
  mediaFileId: string;
  analysisId: number;
}) {
  console.log("[link-onlyfans-bundle-items] start", {
    mediaFileId,
    analysisId,
  });

  if (!mediaFileId || !analysisId) {
    console.log("[link-onlyfans-bundle-items] skipped", {
      reason: "missing_media_file_id_or_analysis_id",
      mediaFileId,
      analysisId,
    });

    return {
      linked: false,
      reason: "missing_media_file_id_or_analysis_id",
      updatedCount: 0,
    };
  }

  const { data: vaultMedia, error: vaultMediaError } = await supabase
    .from("vault_media")
    .select("media_id")
    .eq("id", mediaFileId)
    .maybeSingle();

  if (vaultMediaError) {
    console.error("[link-onlyfans-bundle-items] vault_media error", {
      mediaFileId,
      analysisId,
      error: vaultMediaError.message,
    });

    throw new Error(vaultMediaError.message);
  }

  console.log("[link-onlyfans-bundle-items] vault_media lookup", {
    mediaFileId,
    analysisId,
    vaultMedia,
  });

  if (!vaultMedia?.media_id) {
    console.log("[link-onlyfans-bundle-items] skipped", {
      reason: "vault_media_not_found",
      mediaFileId,
      analysisId,
    });

    return {
      linked: false,
      reason: "vault_media_not_found",
      updatedCount: 0,
    };
  }

  const { data: updatedRows, error: bundleItemsUpdateError } = await supabase
    .from("bundle_items")
    .update({
      media_content_analysis_id: analysisId,
      analysis_id: analysisId,
      updated_at: new Date().toISOString(),
    })
    .eq("media_id", vaultMedia.media_id)
    .is("media_content_analysis_id", null)
    .select("id");

  if (bundleItemsUpdateError) {
    console.error("[link-onlyfans-bundle-items] bundle_items update error", {
      mediaFileId,
      analysisId,
      onlyfansMediaId: vaultMedia.media_id,
      error: bundleItemsUpdateError.message,
    });

    throw new Error(bundleItemsUpdateError.message);
  }

  console.log("[link-onlyfans-bundle-items] updated", {
    mediaFileId,
    analysisId,
    onlyfansMediaId: vaultMedia.media_id,
    updatedCount: updatedRows?.length ?? 0,
    updatedIds: (updatedRows ?? []).map((row: any) => row.id).slice(0, 20),
  });

  return {
    linked: true,
    onlyfansMediaId: vaultMedia.media_id,
    updatedCount: updatedRows?.length ?? 0,
  };
}