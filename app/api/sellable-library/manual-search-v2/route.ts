// telegram-media/app/api/sellable-library/manual-search-v2/route.ts
import { NextRequest, NextResponse } from "next/server";

import {
  isInternalMediaApiRequest,
  normalizeArray,
  normalizeBoolean,
  normalizePositiveInt,
  normalizeString,
  postBackend,
} from "@/lib/sellable-library/shared";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

function normalizeSource(value: unknown) {
  const source = normalizeString(value).toLowerCase();

  if (source === "telegram" || source === "onlyfans") {
    return source;
  }

  return "onlyfans";
}

export async function POST(request: NextRequest) {
  try {
    if (!isInternalMediaApiRequest(request)) {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));

    const filters = body.filters ?? {};
    const options = body.options ?? {};

    const source = normalizeSource(
      body.source ?? filters.source ?? options.source
    );

    const creatorId = normalizeString(
      body.creatorId ??
        body.mediaCreatorId ??
        body.media_creator_id ??
        body.creatorOnlyfansAccountId ??
        body.creator_onlyfans_account_id
    );

    const sessionName = normalizeString(
      body.sessionName ?? body.session_name
    );

    const userId = normalizeString(
      body.userId ??
        body.userOnlyfansAccountId ??
        body.user_onlyfans_account_id ??
        ""
    );

    if (source === "telegram" && !creatorId) {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: "creatorId is required for telegram source",
        },
        { status: 400 }
      );
    }

    if (source === "onlyfans" && !sessionName) {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: "sessionName is required for onlyfans source",
        },
        { status: 400 }
      );
    }

    if (!creatorId && !sessionName) {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: "creatorId or sessionName is required",
        },
        { status: 400 }
      );
    }

    const page = normalizePositiveInt(
      body.page ?? options.page,
      1,
      100000
    );

    const pageSize = normalizePositiveInt(
      body.pageSize ?? options.pageSize,
      20,
      100
    );

    const includeSignedUrls = normalizeBoolean(
      body.includeSignedUrls ?? options.includeSignedUrls,
      false
    );

    const includeEligibility = normalizeBoolean(
      body.includeEligibility ?? options.includeEligibility,
      true
    );

    const includeRejected = normalizeBoolean(
      body.includeRejected ?? options.includeRejected,
      true
    );

    const excludePurchased = normalizeBoolean(
      body.excludePurchased ?? options.excludePurchased,
      Boolean(userId)
    );

    const excludeRecentlySent = normalizeBoolean(
      body.excludeRecentlySent ?? options.excludeRecentlySent,
      Boolean(userId)
    );

    const recentSentWindowHours = normalizePositiveInt(
      body.recentSentWindowHours ?? options.recentSentWindowHours,
      4,
      8760
    );

    const requireBundled = normalizeBoolean(
      body.requireBundled ?? filters.requireBundled ?? options.requireBundled,
      true
    );

    const requireAnalysis = normalizeBoolean(
      body.requireAnalysis ?? filters.requireAnalysis,
      true
    );

    const requireR2Key = normalizeBoolean(
      body.requireR2Key ?? filters.requireR2Key,
      true
    );

    const onlyMultiplatform = normalizeBoolean(
      body.onlyMultiplatform ?? filters.onlyMultiplatform,
      source === "telegram"
    );

    const tags = normalizeArray(filters.tags ?? body.tags);

    const sortBy = normalizeString(
      body.sortBy ??
        filters.sortBy ??
        options.sortBy ??
        (tags.length > 0 ? "best_match" : "created_desc")
    );

    const payload = {
      creatorId,
      source,
      sessionName,
      userId,
      searchTarget: "items",
      page,
      pageSize,
      includeEligibility,
      includeRejected,
      recentSentWindowHours,
      excludePurchased,
      excludeRecentlySent,
      includeItems: true,
      includeSignedUrls,
      sortBy,
      filters: {
        search: normalizeString(filters.search ?? body.search),
        status: normalizeString(filters.status ?? body.status ?? "ready"),
        mediaType: normalizeString(filters.mediaType ?? body.mediaType ?? "BOTH"),
        explicitnessLevels: normalizeArray(
          filters.explicitnessLevels ?? body.explicitnessLevels
        ),
        tags,
        matchMode: normalizeString(filters.matchMode ?? body.matchMode ?? "any"),
        useTagPriority: normalizeBoolean(
          filters.useTagPriority ?? body.useTagPriority,
          tags.some((tag: any) => tag?.priorityLevel || tag?.priorityRank)
        ),
        onlyMultiplatform,
        requireR2Key,
        requireAnalysis,
        requireBundled,
        sortBy,
      },
    };

    const rawResult = await postBackend("/api/bundles/library/search", payload);
    const result = rawResult?.result ?? rawResult;

    return NextResponse.json({
      ok: true,
      success: true,
      endpoint: "/api/bundles/library/search",
      payload,
      result,
      rawResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    console.error("[sellable-library/manual-search-v2]", error);

    return NextResponse.json(
      {
        ok: false,
        success: false,
        error: message,
      },
      { status: 500 }
    );
  }
}