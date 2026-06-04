// lib/media-analysis/services/link-onlyfans-bundle-items.ts

type LinkOnlyFansBundleItemsResult = {
  linked: boolean;
  reason: string;
  mediaContentAnalysisId?: number;
  vaultMediaId?: string;
  onlyfansMediaId?: number | string;
  updatedCount: number;
  updatedBundleItemIds?: string[];
  existingBundleItemsCount?: number;
  alreadyLinkedCount?: number;
  missingLinkCount?: number;
};

export async function linkOnlyFansBundleItemsToAnalysis({
  supabase,
  mediaFileId,
  analysisId,
}: {
  supabase: any;
  mediaFileId: string;
  analysisId: number;
}): Promise<LinkOnlyFansBundleItemsResult> {
  console.log("[link-onlyfans-bundle-items] start", {
    purpose:
      "Link OnlyFans vault media analysis to bundle_items.media_content_analysis_id",
    expectedJoin:
      "media_content_analysis.media_file_id -> vault_media.id -> vault_media.media_id -> bundle_items.media_id",
    mediaFileId,
    analysisId,
  });

  if (!mediaFileId || !analysisId) {
    console.warn("[link-onlyfans-bundle-items] skipped: missing input", {
      reason: "missing_media_file_id_or_analysis_id",
      mediaFileId,
      analysisId,
      expected:
        "mediaFileId must be vault_media.id and analysisId must be media_content_analysis.id",
    });

    return {
      linked: false,
      reason: "missing_media_file_id_or_analysis_id",
      updatedCount: 0,
    };
  }

  const { data: analysisRow, error: analysisError } = await supabase
    .from("media_content_analysis")
    .select("id, media_file_id, r2_key, media_type")
    .eq("id", analysisId)
    .maybeSingle();

  if (analysisError) {
    console.error("[link-onlyfans-bundle-items] media_content_analysis lookup error", {
      table: "media_content_analysis",
      analysisId,
      error: analysisError.message,
    });

    throw new Error(analysisError.message);
  }

  if (!analysisRow) {
    console.warn("[link-onlyfans-bundle-items] skipped: analysis row not found", {
      reason: "media_content_analysis_not_found",
      table: "media_content_analysis",
      expectedMediaContentAnalysisId: analysisId,
      mediaFileId,
      explanation:
        "Cannot save media_content_analysis_id into bundle_items because the target media_content_analysis row does not exist.",
    });

    return {
      linked: false,
      reason: "media_content_analysis_not_found",
      mediaContentAnalysisId: analysisId,
      vaultMediaId: mediaFileId,
      updatedCount: 0,
    };
  }

  console.log("[link-onlyfans-bundle-items] media_content_analysis found", {
    table: "media_content_analysis",
    mediaContentAnalysisId: analysisRow.id,
    mediaFileIdFromAnalysis: analysisRow.media_file_id,
    expectedVaultMediaId: mediaFileId,
    r2Key: analysisRow.r2_key,
    mediaType: analysisRow.media_type,
    mediaFileIdMatchesVaultMediaId:
      String(analysisRow.media_file_id || "") === String(mediaFileId),
  });

  const { data: vaultMedia, error: vaultMediaError } = await supabase
    .from("vault_media")
    .select("id, session_name, media_id, media_type")
    .eq("id", mediaFileId)
    .maybeSingle();

  if (vaultMediaError) {
    console.error("[link-onlyfans-bundle-items] vault_media lookup error", {
      table: "vault_media",
      mediaFileId,
      analysisId,
      error: vaultMediaError.message,
    });

    throw new Error(vaultMediaError.message);
  }

  if (!vaultMedia?.media_id) {
    console.warn("[link-onlyfans-bundle-items] skipped: vault media not found", {
      reason: "vault_media_not_found",
      table: "vault_media",
      expectedVaultMediaId: mediaFileId,
      mediaContentAnalysisId: analysisId,
      explanation:
        "This analysis row points to a vault media id, but that vault_media row was not found. Cannot map to bundle_items.media_id.",
    });

    return {
      linked: false,
      reason: "vault_media_not_found",
      mediaContentAnalysisId: analysisId,
      vaultMediaId: mediaFileId,
      updatedCount: 0,
    };
  }

  console.log("[link-onlyfans-bundle-items] vault_media found", {
    table: "vault_media",
    vaultMediaId: vaultMedia.id,
    sessionName: vaultMedia.session_name,
    onlyfansMediaId: vaultMedia.media_id,
    mediaType: vaultMedia.media_type,
    nextLookup:
      "Looking for bundle_items rows where bundle_items.media_id = vault_media.media_id",
  });

  const { data: existingBundleItems, error: existingBundleItemsError } =
    await supabase
      .from("bundle_items")
      .select("id, bundle_id, media_id, media_content_analysis_id, analysis_id")
      .eq("media_id", vaultMedia.media_id);

  if (existingBundleItemsError) {
    console.error("[link-onlyfans-bundle-items] bundle_items lookup error", {
      table: "bundle_items",
      lookupColumn: "media_id",
      onlyfansMediaId: vaultMedia.media_id,
      mediaContentAnalysisId: analysisId,
      error: existingBundleItemsError.message,
    });

    throw new Error(existingBundleItemsError.message);
  }

  const bundleItems = existingBundleItems ?? [];
  const existingCount = bundleItems.length;

  if (existingCount === 0) {
    console.log("[link-onlyfans-bundle-items] skipped: media is not bundled", {
      reason: "media_has_no_bundle_items",
      table: "bundle_items",
      lookup: {
        column: "media_id",
        value: vaultMedia.media_id,
      },
      mediaContentAnalysisId: analysisId,
      vaultMediaId: mediaFileId,
      sessionName: vaultMedia.session_name,
      onlyfansMediaId: vaultMedia.media_id,
      explanation:
        "This vault media has a media_content_analysis row, but it is not present in bundle_items. That means this media was analyzed, but no bundle was created using this media. Nothing needs to be updated.",
    });

    return {
      linked: false,
      reason: "media_has_no_bundle_items",
      mediaContentAnalysisId: analysisId,
      vaultMediaId: mediaFileId,
      onlyfansMediaId: vaultMedia.media_id,
      updatedCount: 0,
      existingBundleItemsCount: 0,
      alreadyLinkedCount: 0,
      missingLinkCount: 0,
    };
  }

  const bundleIds = Array.from(
    new Set(
      bundleItems
        .map((row: any) => String(row.bundle_id || ""))
        .filter(Boolean)
    )
  );

  let bundlesById = new Map<string, any>();

  if (bundleIds.length > 0) {
    const { data: bundles, error: bundlesError } = await supabase
      .from("bundles")
      .select("id, creator_id, name, status, bundle_type")
      .in("id", bundleIds);

    if (bundlesError) {
      console.error("[link-onlyfans-bundle-items] bundles lookup error", {
        table: "bundles",
        bundleIds: bundleIds.slice(0, 50),
        error: bundlesError.message,
      });

      throw new Error(bundlesError.message);
    }

    bundlesById = new Map(
      (bundles ?? []).map((bundle: any) => [String(bundle.id), bundle])
    );
  }

  const bundleItemPreview = bundleItems.slice(0, 50).map((row: any) => {
    const bundle = bundlesById.get(String(row.bundle_id));

    return {
      bundleItemId: row.id,
      bundleId: row.bundle_id,
      bundleName: bundle?.name ?? null,
      bundleCreatorId: bundle?.creator_id ?? null,
      bundleStatus: bundle?.status ?? null,
      bundleType: bundle?.bundle_type ?? null,
      mediaId: row.media_id,
      currentMediaContentAnalysisId: row.media_content_analysis_id,
      currentAnalysisId: row.analysis_id,
    };
  });

  const alreadyLinkedRows = bundleItems.filter(
    (row: any) => row.media_content_analysis_id != null
  );

  const alreadyLinkedToSameAnalysisRows = bundleItems.filter(
    (row: any) => Number(row.media_content_analysis_id) === Number(analysisId)
  );

  const alreadyLinkedToDifferentAnalysisRows = bundleItems.filter(
    (row: any) =>
      row.media_content_analysis_id != null &&
      Number(row.media_content_analysis_id) !== Number(analysisId)
  );

  const missingLinkRows = bundleItems.filter(
    (row: any) => row.media_content_analysis_id == null
  );

  console.log("[link-onlyfans-bundle-items] bundle_items lookup result", {
    table: "bundle_items",
    lookup: {
      column: "media_id",
      value: vaultMedia.media_id,
    },
    mediaContentAnalysisIdToSave: analysisId,
    vaultMediaId: mediaFileId,
    onlyfansMediaId: vaultMedia.media_id,
    existingBundleItemsCount: existingCount,
    alreadyLinkedCount: alreadyLinkedRows.length,
    alreadyLinkedToSameAnalysisCount: alreadyLinkedToSameAnalysisRows.length,
    alreadyLinkedToDifferentAnalysisCount:
      alreadyLinkedToDifferentAnalysisRows.length,
    missingLinkCount: missingLinkRows.length,
    bundleItemPreview,
  });

  if (missingLinkRows.length === 0) {
    const reason =
      alreadyLinkedToSameAnalysisRows.length === existingCount
        ? "all_bundle_items_already_linked_to_this_media_content_analysis"
        : "all_bundle_items_already_have_media_content_analysis_id";

    console.log("[link-onlyfans-bundle-items] skipped: nothing to update", {
      reason,
      table: "bundle_items",
      mediaContentAnalysisId: analysisId,
      vaultMediaId: mediaFileId,
      onlyfansMediaId: vaultMedia.media_id,
      existingBundleItemsCount: existingCount,
      alreadyLinkedCount: alreadyLinkedRows.length,
      alreadyLinkedToSameAnalysisCount: alreadyLinkedToSameAnalysisRows.length,
      alreadyLinkedToDifferentAnalysisCount:
        alreadyLinkedToDifferentAnalysisRows.length,
      explanation:
        "bundle_items rows exist for this media, but none have media_content_analysis_id NULL. The update intentionally only fills missing/null links and does not overwrite existing links.",
      alreadyLinkedPreview: bundleItemPreview,
    });

    return {
      linked: true,
      reason,
      mediaContentAnalysisId: analysisId,
      vaultMediaId: mediaFileId,
      onlyfansMediaId: vaultMedia.media_id,
      updatedCount: 0,
      existingBundleItemsCount: existingCount,
      alreadyLinkedCount: alreadyLinkedRows.length,
      missingLinkCount: 0,
    };
  }

  console.log("[link-onlyfans-bundle-items] updating bundle_items", {
    action:
      "Saving media_content_analysis_id into bundle_items rows where it is currently NULL",
    table: "bundle_items",
    columnsToUpdate: ["media_content_analysis_id", "analysis_id", "updated_at"],
    mediaContentAnalysisIdToSave: analysisId,
    analysisIdToSave: analysisId,
    where: {
      media_id: vaultMedia.media_id,
      media_content_analysis_id: "IS NULL",
    },
    rowsExpectedToUpdate: missingLinkRows.length,
    missingLinkPreview: missingLinkRows.slice(0, 50).map((row: any) => ({
      bundleItemId: row.id,
      bundleId: row.bundle_id,
      currentMediaContentAnalysisId: row.media_content_analysis_id,
      currentAnalysisId: row.analysis_id,
    })),
  });

  const { data: updatedRows, error: bundleItemsUpdateError } = await supabase
    .from("bundle_items")
    .update({
      media_content_analysis_id: analysisId,
      analysis_id: analysisId,
      updated_at: new Date().toISOString(),
    })
    .eq("media_id", vaultMedia.media_id)
    .is("media_content_analysis_id", null)
    .select("id, bundle_id, media_id, media_content_analysis_id, analysis_id");

  if (bundleItemsUpdateError) {
    console.error("[link-onlyfans-bundle-items] bundle_items update error", {
      table: "bundle_items",
      mediaFileId,
      analysisId,
      onlyfansMediaId: vaultMedia.media_id,
      error: bundleItemsUpdateError.message,
    });

    throw new Error(bundleItemsUpdateError.message);
  }

  const updatedIds = (updatedRows ?? []).map((row: any) => row.id);
  const updatedCount = updatedRows?.length ?? 0;

  if (updatedCount > 0) {
    console.log("[link-onlyfans-bundle-items] saved media_content_analysis_id", {
      success: true,
      message:
        "Saved media_content_analysis_id into bundle_items for bundled OnlyFans media.",
      table: "bundle_items",
      columnsUpdated: ["media_content_analysis_id", "analysis_id", "updated_at"],
      mediaContentAnalysisIdSaved: analysisId,
      analysisIdSaved: analysisId,
      vaultMediaId: mediaFileId,
      onlyfansMediaId: vaultMedia.media_id,
      updatedCount,
      updatedRowsPreview: (updatedRows ?? []).slice(0, 50),
    });
  } else {
    console.warn("[link-onlyfans-bundle-items] update returned zero rows", {
      success: false,
      message:
        "bundle_items rows existed with media_content_analysis_id NULL before update, but Supabase update returned zero rows.",
      table: "bundle_items",
      attemptedColumns: ["media_content_analysis_id", "analysis_id", "updated_at"],
      attemptedMediaContentAnalysisId: analysisId,
      attemptedAnalysisId: analysisId,
      vaultMediaId: mediaFileId,
      onlyfansMediaId: vaultMedia.media_id,
      existingBundleItemsCount: existingCount,
      missingLinkCount: missingLinkRows.length,
      explanation:
        "This is unexpected. Re-check permissions, RLS/admin client, or whether rows changed between lookup and update.",
    });
  }

  return {
    linked: updatedCount > 0,
    reason:
      updatedCount > 0
        ? "saved_media_content_analysis_id_to_bundle_items"
        : "update_returned_zero_rows",
    mediaContentAnalysisId: analysisId,
    vaultMediaId: mediaFileId,
    onlyfansMediaId: vaultMedia.media_id,
    updatedCount,
    updatedBundleItemIds: updatedIds,
    existingBundleItemsCount: existingCount,
    alreadyLinkedCount: alreadyLinkedRows.length,
    missingLinkCount: missingLinkRows.length,
  };
}