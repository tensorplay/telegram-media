// telegram-media/app/api/sellable-library/chat-search-v2/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTaxonomyCategoryOptions } from "@/lib/media-analysis/taxonomy-category-options";

import {
  isInternalMediaApiRequest,
  normalizeBoolean,
  normalizePositiveInt,
  normalizeString,
  postBackend,
} from "@/lib/sellable-library/shared";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

function nowMs() {
  return Date.now();
}

function logStep(step: string, data: Record<string, any> = {}) {
  console.log(`[chat-search-v2][${step}]`, {
    ts: new Date().toISOString(),
    ...data,
  });
}


function normalizeLimit(value: unknown, fallback = 11) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(100, parsed));
}

function normalizeBefore(value: unknown) {
  const raw = normalizeString(value);

  if (!raw) {
    return null;
  }

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid before datetime");
  }

  return date.toISOString();
}

type TaxonomyCategoryOption = {
  label: string;
  taskFormat: string;
  parentCategory: string;
  taxonomyDomain: string;
  description?: string | null;
  tags?: Array<{
    id?: string;
    name: string;
    description?: string | null;
  }>;
};

type ExplicitnessLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

const EXPLICITNESS_LEVELS: ExplicitnessLevel[] = [
  "NONE",
  "LOW",
  "MEDIUM",
  "HIGH",
  "EXTREME",
];

function normalizeExplicitnessLevel(value: any): ExplicitnessLevel {
  const normalized = String(value ?? "").trim().toUpperCase();

  if (EXPLICITNESS_LEVELS.includes(normalized as ExplicitnessLevel)) {
    return normalized as ExplicitnessLevel;
  }

  return "EXTREME";
}

function getExplicitnessFallbackLevelsDown(targetLevel: ExplicitnessLevel) {
  const targetIndex = EXPLICITNESS_LEVELS.indexOf(targetLevel);

  if (targetIndex === -1) {
    return [...EXPLICITNESS_LEVELS].reverse();
  }

  return EXPLICITNESS_LEVELS.slice(0, targetIndex + 1).reverse();
}

function getSearchItemId(item: any) {
  return String(
    item?.id ??
      item?.media_content_analysis_id ??
      item?.mediaContentAnalysisId ??
      ""
  ).trim();
}

function mergeSearchResultPages(results: any[]) {
  const firstResult = results[0] ?? {};
  const itemsById = new Map<string, any>();

  for (const result of results) {
    for (const item of Array.isArray(result?.items) ? result.items : []) {
      const id = getSearchItemId(item);

      if (id && !itemsById.has(id)) {
        itemsById.set(id, item);
      }
    }
  }

  const items = Array.from(itemsById.values());

  return {
    ...firstResult,
    items,
    bundles: [],
    returnedCount: items.length,
    pagination: {
      ...(firstResult?.pagination ?? {}),
      page: 1,
      pageSize: items.length,
      total: items.length,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      offset: 0,
    },
    explicitnessFallback: results.map((result) => ({
      explicitnessLevels: result?.filters?.explicitnessLevels ?? null,
      returnedCount: result?.returnedCount ?? null,
      paginationTotal: result?.pagination?.total ?? null,
    })),
  };
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////



function ensureObject(value: any) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function getTaskLlm(body: any, key: string) {
  const taskLlms = ensureObject(body?.taskLlms);
  const llm = ensureObject(taskLlms[key]);

  return Object.keys(llm).length ? llm : null;
}

function unwrapTaskResult(value: any) {
  return value?.result?.result ?? null;
}

function normalizeSender(sender: any) {
  const value = String(sender ?? "").trim();

  if (
    value === "influencer" ||
    value === "<influencer_name>" ||
    value === "creator"
  ) {
    return "<influencer_name>";
  }

  return "<user_name>";
}

function normalizeMessages(messages: any[]) {
  const now = Date.now();

  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => {
      const safeMessage = ensureObject(message);

      const text = String(
        safeMessage.text ??
          safeMessage.message ??
          safeMessage.content ??
          ""
      ).trim();

      const createdAt =
        safeMessage.createdAt ??
        safeMessage.created_at ??
        safeMessage.timestamp ??
        new Date(now - (messages.length - index) * 60_000).toISOString();

      const id = String(safeMessage.id ?? `debug_msg_${index + 1}`);

      return {
        id,
        sender: normalizeSender(safeMessage.sender),
        text,
        message: text,
        content: text,
        created_at: createdAt,
        timestamp: createdAt,
        media_ids: Array.isArray(
          safeMessage.media_ids ?? safeMessage.mediaIds
        )
          ? safeMessage.media_ids ?? safeMessage.mediaIds
          : [],
        price: Number(safeMessage.price ?? 0) || 0,
        was_purchased:
          safeMessage.was_purchased === true ||
          safeMessage.wasPurchased === true,
        is_tip:
          safeMessage.is_tip === true ||
          safeMessage.isTip === true,
        tip_amount:
          Number(
            safeMessage.tip_amount ??
            safeMessage.tipAmount ??
            0
          ) || 0,
      };
    })
    .filter((message) => message.text);
}

function evaluateRecentSalesGate(
  history: any[],
  {
    maxRecent = 5,
    creatorOnly = true,
  }: {
    maxRecent?: number;
    creatorOnly?: boolean;
  } = {}
) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      disableSelling: false,
      reason: "no_history",
      foundOffer: false,
      anyPurchased: false,
      lastOfferPurchased: null,
    };
  }

  const messages = creatorOnly
    ? [...history]
        .reverse()
        .filter((message) => message?.sender === "<influencer_name>")
    : [...history].reverse();

  const recent = messages.slice(0, maxRecent);

  let foundOffer = false;
  let lastOfferPurchased: boolean | null = null;
  let anyPurchased = false;

  for (const message of recent) {
    if (message?.sender !== "<influencer_name>") {
      continue;
    }

    const price = Number(message?.price ?? 0);
    const isOffer = price > 0;

    if (!isOffer) {
      continue;
    }

    const wasPurchased = message?.was_purchased === true;

    if (!foundOffer) {
      foundOffer = true;
      lastOfferPurchased = wasPurchased;
    }

    if (wasPurchased) {
      anyPurchased = true;
    }
  }

  if (!foundOffer) {
    return {
      disableSelling: false,
      reason: "no_recent_offers",
      foundOffer,
      anyPurchased,
      lastOfferPurchased,
    };
  }

  if (!anyPurchased) {
    return {
      disableSelling: true,
      reason: "recent_offers_none_purchased",
      foundOffer,
      anyPurchased,
      lastOfferPurchased,
    };
  }

  if (lastOfferPurchased === true) {
    return {
      disableSelling: false,
      reason: "last_offer_purchased",
      foundOffer,
      anyPurchased,
      lastOfferPurchased,
    };
  }

  return {
    disableSelling: true,
    reason: "last_offer_not_purchased",
    foundOffer,
    anyPurchased,
    lastOfferPurchased,
  };
}

function buildTaskState({
  creatorId,
  userId,
  conversationId,
  messages,
  influencerName,
  userName,
  influencerSummary,
  userSummary,
}: {
  creatorId: string;
  userId: string;
  conversationId: string;
  messages: any[];
  influencerName: string;
  userName: string;
  influencerSummary?: string | null;
  userSummary?: string | null;
}) {
  const lastMessage = messages[messages.length - 1] ?? null;

  return {
    global: {
      platform: "onlyfans",
      kind: "chat_message",

      creator_id: creatorId,
      user_id: userId,
      chat_id: conversationId,
      message_id: lastMessage?.id ?? null,

      message: lastMessage?.text ?? "",

      user_name: userName,
      display_user_name: userName,

      influencer_name: influencerName,
      display_influencer_name: influencerName,

      private_url: "<private_url>",
      speaker_name: "<influencer_name>",

      sent_by_creator: lastMessage?.sender === "<influencer_name>",
      from_another_creator: false,

      chat_history: messages,

      candidate_tags: [],
      commercial_intent: null,
      explicit_level: null,

      extra_info: {
        media_analysis: {},
        chat_anchor_id: lastMessage?.id ?? null,
        chat_anchor_ts: lastMessage?.created_at ?? null,

        candidate_tags: [],
        commercial_intent: null,
        explicit_level: null,
        user_summary: userSummary ?? "",
        influencer_summary: influencerSummary ?? "",
      },

      product_description: null,
    },
    steps: {},
  };
}

async function runTask({
  taskId,
  state,
  runtime = null,
  input = {},
  llm = null,
}: {
  taskId: string;
  state: any;
  runtime?: any;
  input?: any;
  llm?: any;
}) {
  return postBackend("/api/autochat/tasks/run", {
    taskId,
    state,
    input,
    debug_prompt: true,
    ...(runtime ? { runtime } : {}),
    ...(llm ? { llm } : {}),
  });
}

async function runShouldSellTask(state: any, llm: any = null) {
  return runTask({
    taskId: "SHOULD_SELL_INFLUENCER_DEFAULT",
    state,
    llm,
    input: {
      chat_history: state.global.chat_history,
      influencer_name: state.global.influencer_name,
      user_name: state.global.user_name,
      influencer_summary:
        state.global.extra_info?.influencer_summary ?? "",
      user_summary:
        state.global.extra_info?.user_summary ?? "",
    },
  });
}

function getSelectedContentProductDescription(selectedContent: any): string {
  const directParts = [
    selectedContent?.ai_short_pitch,
    selectedContent?.ai_pitch,
    selectedContent?.ai_hook,
    selectedContent?.description,
    selectedContent?.summary,
    selectedContent?.analysis_summary,
    selectedContent?.media_summary,
    selectedContent?.selected_item?.description,
    selectedContent?.selected_item?.summary,
    selectedContent?.selected_item?.analysis_summary,
    selectedContent?.selected_item?.media_summary,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  const bundleItems = [
    ...(Array.isArray(selectedContent?.items?.locked)
      ? selectedContent.items.locked
      : []),
    ...(Array.isArray(selectedContent?.items?.previews)
      ? selectedContent.items.previews
      : []),
    ...(Array.isArray(selectedContent?.items)
      ? selectedContent.items
      : []),
  ];

  const itemDescriptions = bundleItems
    .map((item: any) =>
      String(
        item?.description ??
          item?.summary ??
          item?.analysis_summary ??
          item?.media_summary ??
          item?.audio_text ??
          ""
      ).trim()
    )
    .filter(Boolean);

  return [...directParts, ...itemDescriptions].join("\n\n");
}

function sanitizeBundleItemForSellingMessage(item: any) {
  return {
    id: item?.id ?? null,
    media_content_analysis_id: item?.media_content_analysis_id ?? null,
    media_id: item?.media_id ?? null,
    display_order: item?.display_order ?? null,
    is_preview: item?.is_preview ?? false,
    media_type: item?.media_type ?? null,
    duration: item?.duration ?? null,
    audio_text: item?.audio_text ?? null,
  };
}

function buildSelectedContentForSellingMessage({
  selectedFinalItem,
  selectedFinalBundle,
}: {
  selectedFinalItem: any;
  selectedFinalBundle: any;
}) {
  const bundle = selectedFinalBundle?.bundle ?? null;
  const bundleItems = Array.isArray(selectedFinalBundle?.items)
    ? selectedFinalBundle.items
    : [];

  if (!bundle) {
    return selectedFinalItem ?? null;
  }

  const previews = bundleItems
    .filter((item: any) => item?.is_preview === true)
    .map(sanitizeBundleItemForSellingMessage);

  const locked = bundleItems
    .filter((item: any) => item?.is_preview !== true)
    .map(sanitizeBundleItemForSellingMessage);

  return {
    ...bundle,
    id: bundle.id,
    bundle_id: bundle.id,
    selected_item: selectedFinalItem,
    items: {
      previews,
      locked,
    },
  };
}

async function runSellingTask({
  state,
  selectedContent,
  shouldSell,
  llm = null,
}: {
  state: any;
  selectedContent: any;
  shouldSell: any;
  llm?: any;
}) {
  const productDescription =
    getSelectedContentProductDescription(selectedContent);

  logStep("selling_message_product_description", {
    selectedContentId:
      selectedContent?.bundle_id ??
      selectedContent?.id ??
      selectedContent?.media_content_analysis_id ??
      null,
    productDescriptionLength: productDescription.length,
    productDescriptionPreview: productDescription.slice(0, 500),
  });

  return runTask({
    taskId: "SELLING_PRODUCT_INFLUENCER_DEFAULT",
    llm,
    state: {
      ...state,
      global: {
        ...state.global,
        product_description: productDescription,
        selected_content: selectedContent,
        should_sell: shouldSell,
        extra_info: {
          ...(state.global?.extra_info ?? {}),
          product_description: productDescription,
          selected_content: selectedContent,
          should_sell: shouldSell,
        },
      },
    },
    input: {
      product_description: productDescription,
      selected_content: selectedContent,
      should_sell: shouldSell,
    },
  });
}

async function loadNewChatSearchParentCategories({
  supabase,
}: {
  supabase: ReturnType<typeof createAdminClient>;
}): Promise<TaxonomyCategoryOption[]> {
  const options = await getTaxonomyCategoryOptions({
    supabase,
    domain: "ADULT",
  });

  const newOptions = options
    .filter((option: any) => String(option.taxonomyDomain ?? "").toUpperCase() === "ADULT")
    .sort((a: any, b: any) =>
      String(a.parentCategory).localeCompare(String(b.parentCategory))
    );

  if (newOptions.length === 0) {
    throw new Error("No active ADULT taxonomy parent categories found");
  }

  return newOptions as TaxonomyCategoryOption[];
}

async function runCategoryActivation(
  state: any,
  parentCategory: string,
  llm: any = null
) {
  return runTask({
    taskId: "MEDIA_CHAT_CATEGORY_ACTIVATION",
    state,
    llm,
    runtime: {
      taxonomyDomain: "ADULT",
      parentCategory,
    },
  });
}

async function resolveActivationResults({
  state,
  parentCategories,
  llm = null,
}: {
  state: any;
  parentCategories: TaxonomyCategoryOption[];
  llm?: any;
}) {
  const entries = await Promise.all(
    parentCategories.map(async (category) => {
      const result = await runCategoryActivation(
        state,
        category.parentCategory,
        llm
      );

      return [category.parentCategory, result] as const;
    })
  );

  return Object.fromEntries(entries);
}

function collectTagsFromBucket(
  domain: string,
  bucket: any,
  categoryOption?: TaxonomyCategoryOption
) {
  const result = unwrapTaskResult(bucket);

  if (!result || typeof result !== "object") {
    return [];
  }

  const tagMetadataByName = new Map<string, any>();

  for (const rawTag of categoryOption?.tags ?? []) {
    const name = String(rawTag?.name ?? "").trim();

    if (!name) {
      continue;
    }

    tagMetadataByName.set(name.toUpperCase(), {
      id: rawTag.id ?? name,
      name,
      description: rawTag.description ?? null,
    });
  }

  const sourceBuckets = [
    {
      source: "direct_mentions",
      weight: 100,
      tags: Array.isArray(result.direct_mentions) ? result.direct_mentions : [],
    },
    {
      source: "implied_contextual",
      weight: 25,
      tags: Array.isArray(result.implied_contextual) ? result.implied_contextual : [],
    },
    {
      source: "historical_suggested",
      weight: 10,
      tags: Array.isArray(result.historical_suggested) ? result.historical_suggested : [],
    },
  ];

  const seen = new Set<string>();
  const out: any[] = [];

  for (const sourceBucket of sourceBuckets) {
    for (const rawTag of sourceBucket.tags) {
      if (rawTag == null) continue;

      const normalizedTag = String(rawTag).trim();
      if (!normalizedTag) continue;

      const metadata = tagMetadataByName.get(normalizedTag.toUpperCase());

      const key = `${domain}:${metadata?.id ?? normalizedTag}`.toUpperCase();
      if (seen.has(key)) continue;

      seen.add(key);

      out.push({
        domain,
        tag: normalizedTag,
        tagId: metadata?.id ?? normalizedTag,
        tagName: metadata?.name ?? normalizedTag,
        tagDescription: metadata?.description ?? null,
        source: sourceBucket.source,
        weight: sourceBucket.weight,
      });
    }
  }

  return out;
}

function buildSellableSearchTags({
  activationResults,
  parentCategories,
}: {
  activationResults: any;
  parentCategories: TaxonomyCategoryOption[];
}) {
  return parentCategories.flatMap((category) =>
    collectTagsFromBucket(
      `ADULT:${category.parentCategory}`,
      activationResults[category.parentCategory],
      category
    )
  );
}

function getTagIdentity(tag: any) {
  const domain = String(tag?.domain ?? "").trim();
  const value = String(tag?.tag ?? tag?.value ?? tag?.name ?? "").trim();

  if (!domain || !value) {
    return null;
  }

  return `${domain}:${value}`.toUpperCase();
}

function normalizeTagCandidate(tag: any) {
  const domain = String(tag?.domain ?? "").trim();
  const value = String(tag?.tag ?? tag?.value ?? tag?.name ?? "").trim();

  if (!domain || !value) {
    return null;
  }

  return {
    ...tag,
    domain,
    tag: value,
  };
}

function dedupeTags(tags: any[]) {
  const seen = new Set<string>();
  const out: any[] = [];

  for (const rawTag of Array.isArray(tags) ? tags : []) {
    const tag = normalizeTagCandidate(rawTag);
    const key = getTagIdentity(tag);

    if (!tag || !key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(tag);
  }

  return out;
}

function extractTagsFromPriorityTaskResult(rawValue: any, allTags: any[]) {
  const result = unwrapTaskResult(rawValue);

  const priority1Raw =
    result?.priority_1 ??
    result?.priority1 ??
    result?.priorityLevel1 ??
    result?.level1 ??
    [];

  const priority2Raw =
    result?.priority_2 ??
    result?.priority2 ??
    result?.priorityLevel2 ??
    result?.level2 ??
    [];

  const priority1 = Array.isArray(priority1Raw)
    ? priority1Raw
    : priority1Raw
      ? [priority1Raw]
      : [];

  const priority2 = Array.isArray(priority2Raw)
    ? priority2Raw
    : priority2Raw
      ? [priority2Raw]
      : [];

  const normalizedAllTags = dedupeTags(allTags);

  const findCandidateTag = (value: any) => {
    if (value && typeof value === "object") {
      const direct = normalizeTagCandidate(value);

      if (direct) {
        return direct;
      }

      const objectTagValue = String(
        value?.tag ?? value?.name ?? value?.value ?? ""
      )
        .trim()
        .toUpperCase();

      return (
        normalizedAllTags.find(
          (tag) => String(tag.tag || "").trim().toUpperCase() === objectTagValue
        ) ?? null
      );
    }

    const tagValue = String(value ?? "").trim().toUpperCase();

    if (!tagValue) {
      return null;
    }

    return (
      normalizedAllTags.find(
        (tag) => String(tag.tag || "").trim().toUpperCase() === tagValue
      ) ?? null
    );
  };

  return {
    priority1: dedupeTags(priority1.map(findCandidateTag).filter(Boolean)),
    priority2: dedupeTags(priority2.map(findCandidateTag).filter(Boolean)),
    rawResult: result,
  };
}

function buildFinalPrioritizedTags({
  allTags,
  priority1,
  priority2,
  priority1Max = 1,
  priority2Max = 3,
}: {
  allTags: any[];
  priority1: any[];
  priority2: any[];
  priority1Max?: number;
  priority2Max?: number;
}) {
  const normalizedAllTags = dedupeTags(allTags);

  const allTagByKey = new Map(
    normalizedAllTags
      .map((tag) => [getTagIdentity(tag), tag] as const)
      .filter(([key]) => Boolean(key))
  );

  const selectedPriority1 = dedupeTags(priority1)
    .filter((tag) => allTagByKey.has(getTagIdentity(tag)))
    .slice(0, priority1Max);

  const selectedPriority1Keys = new Set(
    selectedPriority1.map(getTagIdentity).filter(Boolean)
  );

  const selectedPriority2 = dedupeTags(priority2)
    .filter((tag) => {
      const key = getTagIdentity(tag);

      return key && allTagByKey.has(key) && !selectedPriority1Keys.has(key);
    })
    .slice(0, priority2Max);

  const selectedPriority2Keys = new Set(
    selectedPriority2.map(getTagIdentity).filter(Boolean)
  );

  const selectedKeys = new Set([
    ...selectedPriority1Keys,
    ...selectedPriority2Keys,
  ]);

  const priority3 = normalizedAllTags.filter((tag) => {
    const key = getTagIdentity(tag);

    return key && !selectedKeys.has(key);
  });

  return [
    ...selectedPriority1.map((tag, index) => ({
      ...allTagByKey.get(getTagIdentity(tag)),
      ...tag,
      priorityRank: index + 1,
      priorityLevel: 1,
    })),
    ...selectedPriority2.map((tag, index) => ({
      ...allTagByKey.get(getTagIdentity(tag)),
      ...tag,
      priorityRank: selectedPriority1.length + index + 1,
      priorityLevel: 2,
    })),
    ...priority3.map((tag, index) => ({
      ...tag,
      priorityRank: selectedPriority1.length + selectedPriority2.length + index + 1,
      priorityLevel: 3,
    })),
  ];
}

async function runTagPrioritySelection({
  state,
  tags,
  commercialIntent,
  explicitLevel,
  priority1Max = 1,
  priority2Max = 3,
  llm = null,
}: {
  state: any;
  tags: any[];
  commercialIntent: any;
  explicitLevel: any;
  priority1Max?: number;
  priority2Max?: number;
  llm?: any;
}) {
  const allTags = dedupeTags(tags);

  if (allTags.length === 0) {
    return {
      raw: null,
      rawResult: null,
      tags: [],
      priority1: [],
      priority2: [],
      priority3: [],
    };
  }

  const priorityPolicy = {
    priority1Max,
    priority2Max,
  };

  const priorityState = {
    ...state,
    global: {
      ...state.global,
      candidate_tags: allTags,
      commercial_intent: commercialIntent,
      explicit_level: explicitLevel,
      priorityPolicy,
      extra_info: {
        ...(state.global?.extra_info ?? {}),
        candidate_tags: allTags,
        commercial_intent: commercialIntent,
        explicit_level: explicitLevel,
        priorityPolicy,
      },
    },
  };

  const raw = await runTask({
    taskId: "MEDIA_CHAT_TAG_PRIORITY_SELECTION",
    state: priorityState,
    llm,
    input: {
      priorityPolicy,
    },
  });

  const { priority1, priority2, rawResult } =
    extractTagsFromPriorityTaskResult(raw, allTags);

  const finalTags = buildFinalPrioritizedTags({
    allTags,
    priority1,
    priority2,
    priority1Max,
    priority2Max,
  });

  return {
    raw,
    rawResult,
    tags: finalTags,
    priority1: finalTags.filter((tag) => tag.priorityLevel === 1),
    priority2: finalTags.filter((tag) => tag.priorityLevel === 2),
    priority3: finalTags.filter((tag) => tag.priorityLevel === 3),
  };
}

async function searchSellableItems({
  creatorId,
  sessionName,
  userId,
  commercialIntent,
  explicitLevel,
  tags,
  page = 1,
  pageSize = 20,
  includeSignedUrls = false,
  sortBy = "created_desc",
  requireBundled = true,

  includeEligibility = true,
  includeRejected = true,
  excludePurchased = true,
  excludeRecentlySent = true,
  recentSentWindowHours = 4,
}: {
  creatorId: string;
  sessionName: string;
  userId: string;
  commercialIntent: any;
  explicitLevel: any;
  tags: any[];
  page?: number;
  pageSize?: number;
  includeSignedUrls?: boolean;
  sortBy?: string;
  requireBundled?: boolean;

  includeEligibility?: boolean;
  includeRejected?: boolean;
  excludePurchased?: boolean;
  excludeRecentlySent?: boolean;
  recentSentWindowHours?: number;
}) {
  const targetLevel = normalizeExplicitnessLevel(
    explicitLevel?.max_level ?? explicitLevel?.min_level ?? "EXTREME"
  );

  const explicitnessFallbackLevels =
    getExplicitnessFallbackLevelsDown(targetLevel);

  const effectiveSortBy = tags.length > 0 ? "best_match" : sortBy;

  const buildPayload = (explicitnessLevels: ExplicitnessLevel[]) => ({
    creatorId,
    source: "onlyfans",
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
    sortBy: effectiveSortBy,
    filters: {
      search: "",
      status: "ready",
      mediaType: commercialIntent?.media_type || "BOTH",
      explicitnessLevels,
      tags,
      matchMode: "any",
      useTagPriority: tags.length > 0,
      onlyMultiplatform: false,
      requireR2Key: true,
      requireAnalysis: true,
      requireBundled,
      sortBy: effectiveSortBy,
    },
  });

  const rawResults: any[] = [];
  const normalizedResults: any[] = [];
  const seenItemIds = new Set<string>();

  for (const fallbackLevel of explicitnessFallbackLevels) {
    const payload = buildPayload([fallbackLevel]);

    const rawResult = await postBackend("/api/bundles/library/search", payload);
    const result = rawResult?.result ?? rawResult;

    rawResults.push(rawResult);
    normalizedResults.push(result);

    const currentItems = Array.isArray(result?.items) ? result.items : [];

    for (const item of currentItems) {
      const id = getSearchItemId(item);

      if (id) {
        seenItemIds.add(id);
      }
    }

    if (seenItemIds.size >= pageSize) {
      break;
    }
  }

  const result = mergeSearchResultPages(normalizedResults);

  return {
    endpoint: "/api/bundles/library/search",
    payload: {
      ...buildPayload(explicitnessFallbackLevels),
      explicitnessFallbackLevels,
    },
    rawResult: rawResults,
    result,
  };
}

async function searchForcedPickEligibleItems({
  creatorId,
  sessionName,
  userId,
  commercialIntent,
  explicitLevel,
  pageSize = 100,
  includeSignedUrls = false,
  requireBundled = true,
  includeEligibility = true,
  includeRejected = true,
  excludePurchased = true,
  excludeRecentlySent = true,
  recentSentWindowHours = 4,
}: {
  creatorId: string;
  sessionName: string;
  userId: string;
  commercialIntent: any;
  explicitLevel: any;
  pageSize?: number;
  includeSignedUrls?: boolean;
  requireBundled?: boolean;
  includeEligibility?: boolean;
  includeRejected?: boolean;
  excludePurchased?: boolean;
  excludeRecentlySent?: boolean;
  recentSentWindowHours?: number;
}) {
  const targetLevel = normalizeExplicitnessLevel(
    explicitLevel?.max_level ??
      explicitLevel?.min_level ??
      "EXTREME"
  );

  const allowedExplicitnessLevels =
    getExplicitnessFallbackLevelsDown(targetLevel);

  const payload = {
    creatorId,
    source: "onlyfans",
    sessionName,
    userId,
    searchTarget: "items",
    page: 1,
    pageSize,
    includeEligibility,
    includeRejected,
    recentSentWindowHours,
    excludePurchased,
    excludeRecentlySent,
    includeItems: true,
    includeSignedUrls,
    sortBy: "created_desc",
    filters: {
      search: "",
      status: "ready",
      mediaType: commercialIntent?.media_type || "BOTH",

      // Final fallback: ignore tags, but never exceed the allowed explicitness.
      explicitnessLevels: allowedExplicitnessLevels,

      // Final fallback: ignore taxonomy tag matching.
      tags: [],
      matchMode: "any",
      useTagPriority: false,

      onlyMultiplatform: false,
      requireR2Key: true,
      requireAnalysis: true,
      requireBundled,
      sortBy: "created_desc",
    },
  };

  const rawResult = await postBackend(
    "/api/bundles/library/search",
    payload
  );

  const result = rawResult?.result ?? rawResult;

  return {
    endpoint: "/api/bundles/library/search",
    payload,
    rawResult,
    result: {
      ...result,
      forcedPickFallback: {
        used: true,
        reason: "no_sendable_items_after_tag_search",
        tagsIgnored: true,
        explicitnessIgnored: false,
        targetExplicitnessLevel: targetLevel,
        allowedExplicitnessLevels,
      },
    },
  };
}

function isFinalSelectionCandidateSendable(value: any) {
  return value?.eligibility?.sendable !== false;
}

function uniqueFinalSelectionTags(tags: any[]) {
  const seen = new Set<string>();
  const out: any[] = [];

  for (const rawTag of Array.isArray(tags) ? tags : []) {
    const domain = String(rawTag?.domain ?? "").trim();
    const tag = String(rawTag?.tag ?? rawTag?.name ?? "").trim();

    if (!domain || !tag) {
      continue;
    }

    const key = `${domain}:${tag}`.toUpperCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push({ domain, tag });
  }

  return out;
}

function getCandidateExplicitnessLevel(item: any) {
  return String(
    item?.explicitnessLevel ??
      item?.explicitness_level ??
      item?.selection_meta?.explicitness_level ??
      item?.selection_meta?.explicitnessLevel ??
      ""
  )
    .trim()
    .toUpperCase();
}

function buildFinalContentSelectionCandidates({
  sellable,
  topN,
}: {
  sellable: any;
  topN: number;
}) {
  const items = Array.isArray(sellable?.result?.items)
    ? sellable.result.items
    : [];

  return items
    .filter(isFinalSelectionCandidateSendable)
    .map((item: any) => {
      const summary = String(item?.summary ?? item?.description ?? "").trim();

      return {
        id: getSearchItemId(item),
        summary,
        explicitnessLevel: getCandidateExplicitnessLevel(item),
        tags: uniqueFinalSelectionTags(
          item?.allConfirmedTags ?? item?.matchedTags ?? []
        ),
      };
    })
    .filter((candidate: any) => candidate.id && candidate.summary)
    .slice(0, topN);
}

async function runFinalContentSelection({
  state,
  candidates,
  tagPriority,
  commercialIntent,
  explicitLevel,
  topN,
  llm = null,
}: {
  state: any;
  candidates: any[];
  tagPriority: any;
  commercialIntent: any;
  explicitLevel: any;
  topN: number;
  llm?: any;
}) {
  if (candidates.length === 0) {
    return {
      enabled: true,
      skipped: true,
      reason: "no_usable_candidates",
      raw: null,
      result: null,
      candidates,
    };
  }

  const finalSelectionState = {
    ...state,
    global: {
      ...state.global,
      candidate_tags: tagPriority.tags,
      commercial_intent: commercialIntent,
      explicit_level: explicitLevel,
      candidate_sellable_items: candidates,
      extra_info: {
        ...(state.global?.extra_info ?? {}),
        candidate_tags: tagPriority.tags,
        commercial_intent: commercialIntent,
        explicit_level: explicitLevel,
        candidate_sellable_items: candidates,
      },
    },
  };

  const raw = await runTask({
    taskId: "MEDIA_CHAT_FINAL_CONTENT_SELECTION",
    state: finalSelectionState,
    llm,
    input: {
      topN,
    },
  });

  return {
    enabled: true,
    skipped: false,
    raw,
    result: unwrapTaskResult(raw),
    candidates,
  };
}

function pickRandomArrayItem<T>(items: T[]) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)] ?? null;
}

function shuffleArray<T>(items: T[]) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));

    [shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

async function loadBundleForSelectedItem({
  supabase,
  selectedItem,
  creatorId,
  sessionName,
  userId,
}: {
  supabase: ReturnType<typeof createAdminClient>;
  selectedItem: any;
  creatorId: string;
  sessionName: string;
  userId: string;
}) {
  const selectedMediaContentAnalysisId = Number(getSearchItemId(selectedItem));

  if (!Number.isInteger(selectedMediaContentAnalysisId)) {
    return {
      enabled: true,
      skipped: true,
      reason: "missing_selected_media_content_analysis_id",
      selectedMediaContentAnalysisId: null,
      candidateBundleCount: 0,
      candidateBundleIds: [],
      bundle: null,
      items: [],
    };
  }

  const { data: bundleItemRefs, error: bundleItemRefsError } = await supabase
    .from("bundle_items")
    .select("bundle_id")
    .eq("media_content_analysis_id", selectedMediaContentAnalysisId);

  if (bundleItemRefsError) {
    throw new Error(bundleItemRefsError.message);
  }

  const bundleIds = Array.from(
    new Set(
      (bundleItemRefs ?? [])
        .map((row: any) => String(row.bundle_id ?? "").trim())
        .filter(Boolean)
    )
  );

  if (bundleIds.length === 0) {
    return {
      enabled: true,
      skipped: true,
      reason: "selected_item_not_found_in_any_bundle",
      selectedMediaContentAnalysisId,
      candidateBundleCount: 0,
      candidateBundleIds: [],
      bundle: null,
      items: [],
    };
  }

  const { data: bundleRows, error: bundleRowsError } = await supabase
    .from("bundles")
    .select(`
      id,
      creator_id,
      bundle_type,
      name,
      status,
      created_at,
      updated_at,
      price,
      session_name,
      description,
      ai_pitch,
      ai_short_pitch,
      ai_hook,
      audio_text,
      total_items,
      preview_count,
      locked_count,
      times_sent,
      times_purchased,
      total_revenue,
      conversion_rate,
      last_sent_at,
      tags,
      custom_tags,
      custom_sort_order
    `)
    .in("id", bundleIds)
    .eq("status", "ready");

  if (bundleRowsError) {
    throw new Error(bundleRowsError.message);
  }

  const matchingBundles = (bundleRows ?? []).filter((bundle: any) => {
    const bundleSessionName = String(bundle.session_name ?? "").trim();
    const bundleCreatorId = String(bundle.creator_id ?? "").trim();

    return (
      bundleSessionName === sessionName ||
      bundleCreatorId === creatorId
    );
  });

  if (matchingBundles.length === 0) {
    return {
      enabled: true,
      skipped: true,
      reason: "no_ready_matching_bundle_for_selected_item",
      selectedMediaContentAnalysisId,
      candidateBundleCount: 0,
      candidateBundleIds: [],
      purchasedBundleIds: [],
      availableBundleIds: [],
      bundle: null,
      items: [],
    };
  }

  const numericUserId = Number(userId);
  let purchasedBundleIds: string[] = [];

  if (Number.isInteger(numericUserId)) {
    const { data: purchasedRows, error: purchasedRowsError } = await supabase
      .from("media_sales")
      .select("ppv_bundle_id")
      .eq("session_name", sessionName)
      .eq("user_id", numericUserId)
      .not("ppv_bundle_id", "is", null)
      .in(
        "ppv_bundle_id",
        matchingBundles.map((bundle: any) => bundle.id)
      );

    if (purchasedRowsError) {
      throw new Error(purchasedRowsError.message);
    }

    purchasedBundleIds = Array.from(
      new Set(
        (purchasedRows ?? [])
          .map((row: any) => String(row.ppv_bundle_id ?? "").trim())
          .filter(Boolean)
      )
    );
  }

  const purchasedBundleIdSet = new Set(purchasedBundleIds);

  const availableBundles = matchingBundles.filter(
    (bundle: any) => !purchasedBundleIdSet.has(String(bundle.id))
  );

  if (availableBundles.length === 0) {
    return {
      enabled: true,
      skipped: true,
      reason: "all_candidate_bundles_already_purchased",
      selectedMediaContentAnalysisId,
      candidateBundleCount: matchingBundles.length,
      candidateBundleIds: matchingBundles.map((bundle: any) => bundle.id),
      purchasedBundleIds,
      availableBundleIds: [],
      bundle: null,
      items: [],
    };
  }

  const selectedBundle = pickRandomArrayItem(availableBundles);

  if (!selectedBundle?.id) {
    return {
      enabled: true,
      skipped: true,
      reason: "failed_to_randomly_select_bundle",
      selectedMediaContentAnalysisId,
      candidateBundleCount: matchingBundles.length,
      candidateBundleIds: matchingBundles.map((bundle: any) => bundle.id),
      purchasedBundleIds,
      availableBundleIds: availableBundles.map((bundle: any) => bundle.id),
      bundle: null,
      items: [],
    };
  }

  const { data: selectedBundleItems, error: selectedBundleItemsError } =
    await supabase
      .from("bundle_items")
      .select(`
        id,
        bundle_id,
        media_content_analysis_id,
        display_order,
        is_preview,
        created_at,
        updated_at,
        media_id,
        analysis_id,
        media_type,
        thumbnail_url,
        preview_url,
        duration,
        audio_text,
        voice_id,
        censored_image_data,
        media_asset_id
      `)
      .eq("bundle_id", selectedBundle.id)
      .order("display_order", { ascending: true });

  if (selectedBundleItemsError) {
    throw new Error(selectedBundleItemsError.message);
  }

  return {
    enabled: true,
    skipped: false,
    reason: null,
    selectedMediaContentAnalysisId,
    candidateBundleCount: matchingBundles.length,
    candidateBundleIds: matchingBundles.map((bundle: any) => bundle.id),
    purchasedBundleIds,
    availableBundleIds: availableBundles.map((bundle: any) => bundle.id),
    bundle: selectedBundle,
    items: selectedBundleItems ?? [],
  };
}



function getItemEligibilityReasons(item: any) {
  const reasons = item?.eligibility?.rejectionReasons;

  if (Array.isArray(reasons) && reasons.length > 0) {
    return reasons;
  }

  if (item?.eligibility?.alreadyPurchased) return ["already_purchased"];
  if (item?.eligibility?.sentRecently) return ["sent_recently"];
  if (item?.eligibility?.previouslySent) return ["previously_sent"];

  return ["eligibility_sendable_false"];
}

function buildFilterStep({
  step,
  inputCount,
  keptItems,
  discardedItems,
}: {
  step: string;
  inputCount: number;
  keptItems: any[];
  discardedItems: any[];
}) {
  return {
    step,
    inputCount,
    keptCount: keptItems.length,
    discardedCount: discardedItems.length,
    discardedItems,
  };
}

async function filterItemsWithAvailableBundles({
  supabase,
  items,
  creatorId,
  sessionName,
  userId,
}: {
  supabase: ReturnType<typeof createAdminClient>;
  items: any[];
  creatorId: string;
  sessionName: string;
  userId: string;
}) {
  const validPairs: any[] = [];
  const discardedItems: any[] = [];

  for (const item of items) {
    const bundleResult = await loadBundleForSelectedItem({
      supabase,
      selectedItem: item,
      creatorId,
      sessionName,
      userId,
    });

    const itemId = getSearchItemId(item);

    if (!bundleResult.skipped && bundleResult.bundle) {
      validPairs.push({
        item,
        bundleResult,
      });

      continue;
    }

    discardedItems.push({
      id: itemId,
      reason: bundleResult.reason,
      candidateBundleCount: bundleResult.candidateBundleCount ?? 0,
      candidateBundleIds: bundleResult.candidateBundleIds ?? [],
      purchasedBundleIds: bundleResult.purchasedBundleIds ?? [],
      availableBundleIds: bundleResult.availableBundleIds ?? [],
    });
  }

  return {
    validPairs,
    discardedItems,
  };
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function uniqueStringValues(values: any[]) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
}

function getNumericValues(values: string[]) {
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

async function loadPurchasedMediaDebug({
  supabase,
  sessionName,
  userId,
}: {
  supabase: ReturnType<typeof createAdminClient>;
  sessionName: string;
  userId: string;
}) {
  const numericUserId = Number(userId);

  if (!Number.isInteger(numericUserId)) {
    return {
      enabled: false,
      reason: "non_numeric_user_id",
      bundleIds: [],
      mediaContentAnalysisIds: [],
      mediaIds: [],
      bundleItems: [],
    };
  }

  const { data: salesRows, error: salesError } = await supabase
    .from("media_sales")
    .select("ppv_bundle_id")
    .eq("session_name", sessionName)
    .eq("user_id", numericUserId)
    .not("ppv_bundle_id", "is", null);

  if (salesError) {
    return {
      enabled: false,
      reason: "media_sales_query_error",
      error: salesError.message,
      bundleIds: [],
      mediaContentAnalysisIds: [],
      mediaIds: [],
      bundleItems: [],
    };
  }

  const bundleIds = uniqueStringValues(
    (salesRows ?? []).map((row: any) => row.ppv_bundle_id)
  );

  if (bundleIds.length === 0) {
    return {
      enabled: true,
      reason: null,
      bundleIds: [],
      mediaContentAnalysisIds: [],
      mediaIds: [],
      bundleItems: [],
    };
  }

  const { data: bundleItems, error: bundleItemsError } = await supabase
    .from("bundle_items")
    .select("id, bundle_id, media_content_analysis_id, media_id")
    .in("bundle_id", bundleIds);

  if (bundleItemsError) {
    return {
      enabled: false,
      reason: "bundle_items_query_error",
      error: bundleItemsError.message,
      bundleIds,
      mediaContentAnalysisIds: [],
      mediaIds: [],
      bundleItems: [],
    };
  }

  return {
    enabled: true,
    reason: null,
    bundleIds,
    mediaContentAnalysisIds: uniqueStringValues(
      (bundleItems ?? []).map((item: any) => item.media_content_analysis_id)
    ),
    mediaIds: uniqueStringValues(
      (bundleItems ?? []).map((item: any) => item.media_id)
    ),
    bundleItems: bundleItems ?? [],
  };
}

async function loadRecentSentMediaDebug({
  supabase,
  creatorOnlyfansAccountId,
  userOnlyfansAccountId,
  sessionName,
  recentSentWindowHours,
}: {
  supabase: ReturnType<typeof createAdminClient>;
  creatorOnlyfansAccountId: string;
  userOnlyfansAccountId: string;
  sessionName: string;
  recentSentWindowHours: number;
}) {
  const cutoffIso = new Date(
    Date.now() - recentSentWindowHours * 60 * 60 * 1000
  ).toISOString();

  const { data: messageRows, error: messagesError } = await supabase
    .from("chat_messages")
    .select(`
      id,
      message_id,
      session_name,
      creator_onlyfans_account_id,
      user_onlyfans_account_id,
      from_creator,
      media_count,
      media_ids,
      price,
      created_at_of
    `)
    .eq("creator_onlyfans_account_id", creatorOnlyfansAccountId)
    .eq("user_onlyfans_account_id", userOnlyfansAccountId)
    .eq("session_name", sessionName)
    .eq("from_creator", true)
    .gte("created_at_of", cutoffIso)
    .order("created_at_of", { ascending: false });

  if (messagesError) {
    return {
      enabled: false,
      reason: "chat_messages_query_error",
      error: messagesError.message,
      recentSentWindowHours,
      cutoffIso,
      messageIds: [],
      mediaIds: [],
      mediaContentAnalysisIds: [],
      messages: [],
      bundleItems: [],
    };
  }

  const messagesWithMedia = (messageRows ?? []).filter(
    (row: any) => Array.isArray(row.media_ids) && row.media_ids.length > 0
  );

  const mediaIds = uniqueStringValues(
    messagesWithMedia.flatMap((row: any) => row.media_ids ?? [])
  );

  if (mediaIds.length === 0) {
    return {
      enabled: true,
      reason: null,
      recentSentWindowHours,
      cutoffIso,
      messageIds: uniqueStringValues(
        messagesWithMedia.map((row: any) => row.message_id)
      ),
      mediaIds: [],
      mediaContentAnalysisIds: [],
      messages: messagesWithMedia,
      bundleItems: [],
    };
  }

  const numericMediaIds = getNumericValues(mediaIds);

  const { data: bundleItems, error: bundleItemsError } = await supabase
    .from("bundle_items")
    .select("id, bundle_id, media_content_analysis_id, media_id")
    .in("media_id", numericMediaIds.length > 0 ? numericMediaIds : mediaIds);

  if (bundleItemsError) {
    return {
      enabled: false,
      reason: "bundle_items_query_error",
      error: bundleItemsError.message,
      recentSentWindowHours,
      cutoffIso,
      messageIds: uniqueStringValues(
        messagesWithMedia.map((row: any) => row.message_id)
      ),
      mediaIds,
      mediaContentAnalysisIds: [],
      messages: messagesWithMedia,
      bundleItems: [],
    };
  }

  return {
    enabled: true,
    reason: null,
    recentSentWindowHours,
    cutoffIso,
    messageIds: uniqueStringValues(
      messagesWithMedia.map((row: any) => row.message_id)
    ),
    mediaIds,
    mediaContentAnalysisIds: uniqueStringValues(
      (bundleItems ?? []).map((item: any) => item.media_content_analysis_id)
    ),
    messages: messagesWithMedia,
    bundleItems: bundleItems ?? [],
  };
}

async function loadUserMediaEligibilityDebug({
  supabase,
  creatorOnlyfansAccountId,
  userOnlyfansAccountId,
  sessionName,
  recentSentWindowHours,
}: {
  supabase: ReturnType<typeof createAdminClient>;
  creatorOnlyfansAccountId: string;
  userOnlyfansAccountId: string;
  sessionName: string;
  recentSentWindowHours: number;
}) {
  const [purchased, recentSent] = await Promise.all([
    loadPurchasedMediaDebug({
      supabase,
      sessionName,
      userId: userOnlyfansAccountId,
    }),
    loadRecentSentMediaDebug({
      supabase,
      creatorOnlyfansAccountId,
      userOnlyfansAccountId,
      sessionName,
      recentSentWindowHours,
    }),
  ]);

  return {
    purchased,
    recentSent,
  };
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function mapChatMessage(row: any) {
  return {
    id: String(row.message_id),
    dbId: row.id,
    messageId: row.message_id,
    sender: row.from_creator ? "influencer" : "user",
    text: row.text || "",
    createdAt: row.created_at_of,
    fromCreator: !!row.from_creator,
    price: row.price,
    mediaCount: row.media_count || 0,
    mediaIds: Array.isArray(row.media_ids) ? row.media_ids : [],
    media: row.media || null,
    wasPurchased:
      row.from_creator === true &&
      row.is_opened === true &&
      Number(row.price ?? 0) > 0,
    raw: row,
  };
}

async function loadRealOfContext({
  supabase,
  creatorOnlyfansAccountId,
  userOnlyfansAccountId,
  sessionName,
  before,
  limit,
}: {
  supabase: ReturnType<typeof createAdminClient>;
  creatorOnlyfansAccountId: string;
  userOnlyfansAccountId: string;
  sessionName: string;
  before: string | null;
  limit: number;
}) {
  let messagesQuery = supabase
    .from("chat_messages")
    .select(`
      id,
      creator_onlyfans_account_id,
      user_onlyfans_account_id,
      session_name,
      message_id,
      from_creator,
      from_user_id,
      to_user_id,
      text,
      price,
      is_tip,
      is_opened,
      media_count,
      media_ids,
      media,
      created_at_of,
      created_at,
      updated_at
    `)
    .eq("creator_onlyfans_account_id", creatorOnlyfansAccountId)
    .eq("user_onlyfans_account_id", userOnlyfansAccountId)
    .is("deleted_at", null);

  if (before) {
    messagesQuery = messagesQuery.lte("created_at_of", before);
  }

  const { data: messageRows, error: messagesError } = await messagesQuery
    .order("created_at_of", { ascending: false })
    .order("message_id", { ascending: false })
    .limit(limit);

  if (messagesError) {
    throw new Error(messagesError.message);
  }

  const messages = [...(messageRows ?? [])].reverse().map(mapChatMessage);

  const { data: sessionRow, error: sessionError } = await supabase
    .from("autochat_sessions")
    .select(`
      id,
      creator_onlyfans_account_id,
      user_onlyfans_account_id,
      session_name,
      display_user_name,
      display_influencer_name,
      conversation_summary,
      user_emotions
    `)
    .eq("creator_onlyfans_account_id", creatorOnlyfansAccountId)
    .eq("user_onlyfans_account_id", userOnlyfansAccountId)
    .limit(1)
    .maybeSingle();

  if (sessionError) {
    throw new Error(sessionError.message);
  }

  const { data: configRow, error: configError } = await supabase
    .from("autochat_config")
    .select(`
      creator_onlyfans_account_id,
      ws_session_name,
      persona_profile
    `)
    .eq("creator_onlyfans_account_id", creatorOnlyfansAccountId)
    .limit(1)
    .maybeSingle();

  if (configError) {
    throw new Error(configError.message);
  }

  const displayUserName = normalizeString(sessionRow?.display_user_name);
  const displayInfluencerName = normalizeString(
    sessionRow?.display_influencer_name
  );

  const userSummary = normalizeString(sessionRow?.conversation_summary);
  const influencerSummary = normalizeString(configRow?.persona_profile);

  return {
    inputMode: "real_of",
    creatorOnlyfansAccountId,
    userOnlyfansAccountId,
    sessionName: normalizeString(
      sessionRow?.session_name ?? configRow?.ws_session_name ?? sessionName
    ),
    before,
    limit,
    messages,
    displayUserName,
    displayInfluencerName,
    userSummary,
    influencerSummary,
    debug: {
      sessionFound: Boolean(sessionRow),
      configFound: Boolean(configRow),
      messageCount: messages.length,
    },
  };
}

function resolveSimulatedContext(body: any) {
  const creatorOnlyfansAccountId = normalizeString(
    body.creatorOnlyfansAccountId ?? body.creator_onlyfans_account_id
  );

  const sessionName = normalizeString(body.sessionName ?? body.session_name);

  const messages = Array.isArray(body.messages) ? body.messages : [];

  const displayUserName = normalizeString(body.displayUserName);
  const displayInfluencerName = normalizeString(body.displayInfluencerName);
  const userSummary = normalizeString(body.userSummary);
  const influencerSummary = normalizeString(body.influencerSummary);

  if (!creatorOnlyfansAccountId) {
    throw new Error("creatorOnlyfansAccountId is required");
  }

  if (messages.length === 0) {
    throw new Error("messages is required for simulated chat search");
  }

  if (!displayUserName) {
    throw new Error("displayUserName is required for simulated chat search");
  }

  if (!displayInfluencerName) {
    throw new Error("displayInfluencerName is required for simulated chat search");
  }

  return {
    inputMode: "simulated",
    creatorOnlyfansAccountId,
    userOnlyfansAccountId: null,
    sessionName,
    before: null,
    limit: messages.length,
    messages,
    displayUserName,
    displayInfluencerName,
    userSummary,
    influencerSummary,
    debug: {
      sessionFound: false,
      configFound: false,
      messageCount: messages.length,
    },
  };
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

    const supabase = createAdminClient();
    const body = await request.json().catch(() => ({}));

    const requestStartedAt = nowMs();

    const simulated = body.simulated === true;

    logStep("start", {
      simulated,
      creatorOnlyfansAccountId:
        body.creatorOnlyfansAccountId ?? body.creator_onlyfans_account_id,
      userOnlyfansAccountId:
        body.userOnlyfansAccountId ?? body.user_onlyfans_account_id,
      sessionName: body.sessionName ?? body.session_name,
      before: body.before ?? null,
      limit: body.limit ?? null,
      tasks: body.tasks ?? null,
      taskLlms: body.taskLlms ?? null,
      options: body.options ?? null,
    });

    const contextStartedAt = nowMs();

    const context = simulated
      ? resolveSimulatedContext(body)
      : await loadRealOfContext({
          supabase,
          creatorOnlyfansAccountId: normalizeString(
            body.creatorOnlyfansAccountId ?? body.creator_onlyfans_account_id
          ),
          userOnlyfansAccountId: normalizeString(
            body.userOnlyfansAccountId ?? body.user_onlyfans_account_id
          ),
          sessionName: normalizeString(
            body.sessionName ?? body.session_name
          ),
          before: normalizeBefore(body.before),
          limit: normalizeLimit(body.limit, 11),
        });

    logStep("context_loaded", {
      elapsedMs: nowMs() - contextStartedAt,
      totalElapsedMs: nowMs() - requestStartedAt,
      inputMode: context.inputMode,
      sessionName: context.sessionName,
      messageCount: context.messages.length,
      hasDisplayUserName: Boolean(context.displayUserName),
      hasDisplayInfluencerName: Boolean(context.displayInfluencerName),
      userSummaryLength: context.userSummary.length,
      influencerSummaryLength: context.influencerSummary.length,
      debug: context.debug,
    });

    const normalizedMessages = normalizeMessages(context.messages);

    if (normalizedMessages.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: "At least one message is required",
        },
        { status: 400 }
      );
    }

    const userId = normalizeString(
      context.userOnlyfansAccountId ?? body.userId ?? body.user_id ?? "debug_user"
    );

    const conversationId = normalizeString(
      body.conversationId ??
        body.conversation_id ??
        `debug_${userId}`
    );

    const state = buildTaskState({
      creatorId: context.creatorOnlyfansAccountId,
      userId,
      conversationId,
      messages: normalizedMessages,
      influencerName: context.displayInfluencerName,
      userName: context.displayUserName,
      influencerSummary: context.influencerSummary,
      userSummary: context.userSummary,
    });

    const tasks = {
      shouldSell: body?.tasks?.shouldSell !== false,
      suggestContent: body?.tasks?.suggestContent !== false,
      searchContent: body?.tasks?.searchContent !== false,
      finalContentSelection:
        body?.tasks?.finalContentSelection !== false &&
        body?.options?.enableFinalContentSelection !== false,
      sellingMessage:
        body?.tasks?.sellingMessage === true ||
        body?.options?.enableSellingMessage === true,
    };

    const taskLlms = {
      shouldSell: getTaskLlm(body, "shouldSell"),
      commercialIntent: getTaskLlm(body, "commercialIntent"),
      explicitLevel: getTaskLlm(body, "explicitLevel"),
      categoryActivation: getTaskLlm(body, "categoryActivation"),
      tagPriority: getTaskLlm(body, "tagPriority"),
      finalContentSelection: getTaskLlm(body, "finalContentSelection"),
      sellingMessage: getTaskLlm(body, "sellingMessage"),
    };

    const enableRecentSalesGate = normalizeBoolean(
      body.enableRecentSalesGate ??
        body.options?.enableRecentSalesGate,
      true,
    );

    const recentSalesGate =
      tasks.shouldSell && enableRecentSalesGate
        ? evaluateRecentSalesGate(normalizedMessages, {
            maxRecent: normalizePositiveInt(
              body.options?.maxMessagesToCheckToBlockSales,
              5,
              100,
            ),
            creatorOnly: normalizeBoolean(
              body.options?.checkCreatorMessagesOnlyToBlockSales,
              true,
            ),
          })
        : {
            disableSelling: false,
            reason: tasks.shouldSell
              ? "recent_sales_gate_disabled"
              : "should_sell_task_disabled",
            foundOffer: false,
            anyPurchased: false,
            lastOfferPurchased: null,
          };

    logStep("recent_sales_gate_done", recentSalesGate);

    const shouldSellStartedAt = nowMs();

    const shouldSellRaw =
      tasks.shouldSell && !recentSalesGate.disableSelling
        ? await runShouldSellTask(state, taskLlms.shouldSell)
        : null;

    const shouldSell = recentSalesGate.disableSelling
      ? {
          should_sell: false,
          reason: recentSalesGate.reason,
          source: "recent_sales_gate",
        }
      : shouldSellRaw
        ? unwrapTaskResult(shouldSellRaw)
        : null;

    logStep("should_sell_done", {
      enabled: tasks.shouldSell,
      elapsedMs: nowMs() - shouldSellStartedAt,
      totalElapsedMs: nowMs() - requestStartedAt,
      shouldSell: shouldSell?.should_sell ?? null,
    });

    const stopWhenShouldSellFalse = normalizeBoolean(
      body.stopWhenShouldSellFalse ?? body.options?.stopWhenShouldSellFalse,
      false
    );

    const shouldSellDecision =
      shouldSell?.should_sell ?? shouldSell?.shouldSell ?? null;

    if (
      tasks.shouldSell &&
      stopWhenShouldSellFalse &&
      shouldSellDecision === false
    ) {
      logStep("stop_should_sell_false", {
        stopWhenShouldSellFalse,
        shouldSellDecision,
      });

      return NextResponse.json({
        ok: true,
        success: true,
        context: {
          ...context,
          messages: normalizedMessages,
        },
        options: body.options ?? {},
        tasks,
        taskLlms,
        analysis: {
          shouldSell,
          shouldSellRaw,

          commercialIntent: null,
          commercialIntentRaw: null,

          explicitLevel: null,
          explicitLevelRaw: null,

          activationResults: null,
          rawTags: [],

          tagPriorityRaw: null,
          tagPriorityResult: null,
          prioritizedTags: [],
          priority1Tags: [],
          priority2Tags: [],
          priority3Tags: [],

          stopReason:
            recentSalesGate.disableSelling
              ? recentSalesGate.reason
              : "should_sell_false",

          debug: {
            stopWhenShouldSellFalse,
            shouldSellDecision,
            recentSalesGate,
            filterSteps: [],
            userMediaEligibilityDebug: null,
          },

          finalContentSelection: {
            enabled: false,
            skipped: true,
            reason: "should_sell_false",
            raw: null,
            result: null,
            candidates: [],
          },

          finalSelectedItem: null,
          finalSelectedBundle: null,

          sellingMessage: null,
          sellingMessageRaw: null,
        },
        sellable: null,
      });
    }

    let commercialIntentRaw: any = null;
    let explicitLevelRaw: any = null;
    let commercialIntent: any = null;
    let explicitLevel: any = null;
    let parentCategories: TaxonomyCategoryOption[] = [];
    let activationResults: any = null;
    let rawTags: any[] = [];
    let tagPriority: any = {
      raw: null,
      rawResult: null,
      tags: [],
      priority1: [],
      priority2: [],
      priority3: [],
    };

    if (tasks.suggestContent) {
      const criteriaStartedAt = nowMs();

      logStep("criteria_start", {
        tasks: [
          "MEDIA_COMMERCIAL_INTENT_ANALYSIS",
          "MEDIA_EXPLICIT_LEVEL_ANALYSIS",
          "loadNewChatSearchParentCategories",
        ],
      });

      const [
        commercialIntentResult,
        explicitLevelResult,
        loadedParentCategories,
      ] = await Promise.all([
        runTask({
          taskId: "MEDIA_COMMERCIAL_INTENT_ANALYSIS",
          state,
          llm: taskLlms.commercialIntent,
        }),
        runTask({
          taskId: "MEDIA_EXPLICIT_LEVEL_ANALYSIS",
          state,
          llm: taskLlms.explicitLevel,
        }),
        loadNewChatSearchParentCategories({
          supabase,
        }),
      ]);

      commercialIntentRaw = commercialIntentResult;
      explicitLevelRaw = explicitLevelResult;      
      parentCategories = loadedParentCategories;

      commercialIntent = unwrapTaskResult(commercialIntentRaw);
      explicitLevel = unwrapTaskResult(explicitLevelRaw);

      logStep("criteria_done", {
        elapsedMs: nowMs() - criteriaStartedAt,
        totalElapsedMs: nowMs() - requestStartedAt,
        mediaType: commercialIntent?.media_type ?? null,
        paymentIntent: commercialIntent?.payment_intent ?? null,
        explicitMin: explicitLevel?.min_level ?? null,
        explicitMax: explicitLevel?.max_level ?? null,
        parentCategoryCount: parentCategories.length,
        parentCategories: parentCategories.map((category) => category.parentCategory),
      });

      const taxonomyStartedAt = nowMs();

      logStep("taxonomy_activation_start", {
        parentCategoryCount: parentCategories.length,
        parentCategories: parentCategories.map((category) => category.parentCategory),
      });

      activationResults = await resolveActivationResults({
        state,
        parentCategories,
        llm: taskLlms.categoryActivation,
      });

      rawTags = buildSellableSearchTags({
        activationResults,
        parentCategories,
      });

      logStep("taxonomy_activation_done", {
        elapsedMs: nowMs() - taxonomyStartedAt,
        totalElapsedMs: nowMs() - requestStartedAt,
        rawTagCount: rawTags.length,
      });

      const priorityStartedAt = nowMs();

      tagPriority = await runTagPrioritySelection({
        state,
        tags: rawTags,
        commercialIntent,
        explicitLevel,
        priority1Max: Number(body.priority1Max ?? 1),
        priority2Max: Number(body.priority2Max ?? 3),
        llm: taskLlms.tagPriority,
      });

      logStep("tag_priority_done", {
        elapsedMs: nowMs() - priorityStartedAt,
        totalElapsedMs: nowMs() - requestStartedAt,
        total: tagPriority.tags.length,
        priority1: tagPriority.priority1.length,
        priority2: tagPriority.priority2.length,
        priority3: tagPriority.priority3.length,
      });
    }

    const page = Math.max(1, Number(body.page ?? body.options?.page ?? 1) || 1);

    const pageSize = Math.min(
      100,
      Math.max(1, Number(body.pageSize ?? body.options?.pageSize ?? 20) || 20)
    );

    const includeSignedUrls =
      body.includeSignedUrls === true || body.options?.includeSignedUrls === true;

    const sortBy = String(body.sortBy ?? body.options?.sortBy ?? "created_desc");

    const requireBundled =
      body.requireBundled !== false && body.options?.requireBundled !== false;

    const includeEligibility = normalizeBoolean(
      body.includeEligibility ?? body.options?.includeEligibility,
      true
    );

    const includeRejected = normalizeBoolean(
      body.includeRejected ?? body.options?.includeRejected,
      true
    );

    const excludePurchased = normalizeBoolean(
      body.excludePurchased ?? body.options?.excludePurchased,
      Boolean(userId)
    );

    const excludeRecentlySent = normalizeBoolean(
      body.excludeRecentlySent ?? body.options?.excludeRecentlySent,
      Boolean(userId)
    );

    const recentSentWindowHours = normalizePositiveInt(
      body.recentSentWindowHours ?? body.options?.recentSentWindowHours,
      4,
      8760
    );

    const includeUserMediaExclusionDebug = normalizeBoolean(
      body.includeUserMediaExclusionDebug ??
        body.options?.includeUserMediaExclusionDebug,
      false
    );

    const userMediaEligibilityDebug = includeUserMediaExclusionDebug
      ? await loadUserMediaEligibilityDebug({
          supabase,
          creatorOnlyfansAccountId: context.creatorOnlyfansAccountId,
          userOnlyfansAccountId: userId,
          sessionName: context.sessionName,
          recentSentWindowHours,
        })
      : null;

    if (includeUserMediaExclusionDebug) {
      logStep("user_media_eligibility_debug_loaded", {
        purchasedBundleCount:
          userMediaEligibilityDebug?.purchased?.bundleIds?.length ?? 0,
        purchasedMediaContentAnalysisCount:
          userMediaEligibilityDebug?.purchased?.mediaContentAnalysisIds?.length ??
          0,
        recentSentMessageCount:
          userMediaEligibilityDebug?.recentSent?.messageIds?.length ?? 0,
        recentSentMediaCount:
          userMediaEligibilityDebug?.recentSent?.mediaIds?.length ?? 0,
        recentSentMediaContentAnalysisCount:
          userMediaEligibilityDebug?.recentSent?.mediaContentAnalysisIds?.length ??
          0,
      });
    }

    const searchStartedAt = nowMs();
    logStep("search_start", {
      enabled: tasks.searchContent && tasks.suggestContent,
      page,
      pageSize,
      includeSignedUrls,
      sortBy,
      requireBundled,
      includeEligibility,
      includeRejected,
      excludePurchased,
      excludeRecentlySent,
      recentSentWindowHours,
      includeUserMediaExclusionDebug,
      tagCount: tagPriority.tags.length,
      mediaType: commercialIntent?.media_type ?? null,
      explicitMin: explicitLevel?.min_level ?? null,
      explicitMax: explicitLevel?.max_level ?? null,
    });

    let sellable:
      | Awaited<ReturnType<typeof searchSellableItems>>
      | Awaited<ReturnType<typeof searchForcedPickEligibleItems>>
      | null =
      tasks.searchContent && tasks.suggestContent
        ? await searchSellableItems({
            creatorId: context.creatorOnlyfansAccountId,
            sessionName: context.sessionName,
            userId,
            commercialIntent,
            explicitLevel,
            tags: tagPriority.tags,
            page,
            pageSize,
            includeSignedUrls,
            sortBy,
            requireBundled,

            includeEligibility,
            includeRejected,
            excludePurchased,
            excludeRecentlySent,
            recentSentWindowHours,
          })
        : null;

    logStep("search_done", {
      enabled: tasks.searchContent && tasks.suggestContent,
      elapsedMs: nowMs() - searchStartedAt,
      totalElapsedMs: nowMs() - requestStartedAt,
      returnedCount: sellable?.result?.returnedCount ?? null,
      itemsCount: Array.isArray(sellable?.result?.items)
        ? sellable.result.items.length
        : null,
      explicitnessFallback: sellable?.result?.explicitnessFallback ?? null,
    });


    const filterSteps: any[] = [];

    let forcedPickFallbackUsed = false;

    let searchItems = Array.isArray(sellable?.result?.items)
      ? sellable.result.items
      : [];

    filterSteps.push({
      step: "search_results",
      inputCount: searchItems.length,
      keptCount: searchItems.length,
      discardedCount: 0,
      discardedItems: [],
      meta: {
        requireBundled,
        requireAnalysis: true,
        requireR2Key: true,
        explicitnessFallback:
          sellable?.result?.explicitnessFallback ?? null,
      },
    });

    let sendableSearchItems = searchItems.filter(
      (item: any) => item?.eligibility?.sendable !== false
    );

    let nonSendableSearchItems = searchItems
      .filter((item: any) => item?.eligibility?.sendable === false)
      .map((item: any) => ({
        id: getSearchItemId(item),
        reasons: getItemEligibilityReasons(item),
      }));

    let sendableFilterStep = buildFilterStep({
      step: "sendable_filter",
      inputCount: searchItems.length,
      keptItems: sendableSearchItems,
      discardedItems: nonSendableSearchItems,
    });

    filterSteps.push(sendableFilterStep);

    logStep("filter_sendable_done", {
      inputCount: sendableFilterStep.inputCount,
      keptCount: sendableFilterStep.keptCount,
      discardedCount: sendableFilterStep.discardedCount,
    });

    /*
    * Final fallback:
    * The normal search already exhausted tag matching and explicitness
    * fallback down to NONE. If no sendable items remain, search again
    * without tags while keeping the maximum allowed explicitness.
    */
    if (
      tasks.searchContent &&
      tasks.suggestContent &&
      sendableSearchItems.length === 0
    ) {
      const forcedPickSearchStartedAt = nowMs();

      logStep("forced_pick_search_start", {
        reason: "no_sendable_items_after_tag_and_explicitness_search",
        mediaType: commercialIntent?.media_type ?? null,
        pageSize: 100,
      });

      const forcedPickSellable =
        await searchForcedPickEligibleItems({
          creatorId: context.creatorOnlyfansAccountId,
          sessionName: context.sessionName,
          userId,
          commercialIntent,
          explicitLevel,
          pageSize: 100,
          includeSignedUrls,
          requireBundled,
          includeEligibility,
          includeRejected,
          excludePurchased,
          excludeRecentlySent,
          recentSentWindowHours,
        });

      const forcedPickSearchItems = Array.isArray(
        forcedPickSellable?.result?.items
      )
        ? forcedPickSellable.result.items
        : [];

      filterSteps.push({
        step: "forced_pick_search_results",
        inputCount: forcedPickSearchItems.length,
        keptCount: forcedPickSearchItems.length,
        discardedCount: 0,
        discardedItems: [],
        meta: {
          tagsIgnored: true,
          explicitnessIgnored: false,
          targetExplicitnessLevel: normalizeExplicitnessLevel(
            explicitLevel?.max_level ??
              explicitLevel?.min_level ??
              "EXTREME"
          ),
          explicitnessLevels: getExplicitnessFallbackLevelsDown(
            normalizeExplicitnessLevel(
              explicitLevel?.max_level ??
                explicitLevel?.min_level ??
                "EXTREME"
            )
          ),
          requireBundled,
          requireAnalysis: true,
          requireR2Key: true,
        },
      });

      const forcedPickSendableItems = forcedPickSearchItems.filter(
        (item: any) => item?.eligibility?.sendable !== false
      );

      const forcedPickRejectedItems = forcedPickSearchItems
        .filter((item: any) => item?.eligibility?.sendable === false)
        .map((item: any) => ({
          id: getSearchItemId(item),
          reasons: getItemEligibilityReasons(item),
        }));

      const forcedPickSendableFilterStep = buildFilterStep({
        step: "forced_pick_sendable_filter",
        inputCount: forcedPickSearchItems.length,
        keptItems: forcedPickSendableItems,
        discardedItems: forcedPickRejectedItems,
      });

      filterSteps.push(forcedPickSendableFilterStep);

      logStep("forced_pick_search_done", {
        elapsedMs: nowMs() - forcedPickSearchStartedAt,
        inputCount: forcedPickSearchItems.length,
        sendableCount: forcedPickSendableItems.length,
        discardedCount: forcedPickRejectedItems.length,
      });

      if (forcedPickSendableItems.length > 0) {
        forcedPickFallbackUsed = true;
        sellable = forcedPickSellable;
        searchItems = forcedPickSearchItems;
        sendableSearchItems = forcedPickSendableItems;
        nonSendableSearchItems = forcedPickRejectedItems;
        sendableFilterStep = forcedPickSendableFilterStep;
      }
    }

    if (
      tasks.searchContent &&
      tasks.suggestContent &&
      sendableSearchItems.length === 0
    ) {
      logStep("stop_no_sendable_items_after_search", {
        filterSteps,
      });

      return NextResponse.json({
        ok: true,
        success: true,
        context: {
          ...context,
          messages: normalizedMessages,
        },
        options: body.options ?? {},
        tasks,
        taskLlms,
        analysis: {
          shouldSell,
          shouldSellRaw,
          commercialIntent,
          commercialIntentRaw,
          explicitLevel,
          explicitLevelRaw,
          activationResults,
          rawTags,
          tagPriorityRaw: tagPriority.raw,
          tagPriorityResult: tagPriority.rawResult,
          prioritizedTags: tagPriority.tags,
          priority1Tags: tagPriority.priority1,
          priority2Tags: tagPriority.priority2,
          priority3Tags: tagPriority.priority3,
          stopReason: "no_sendable_items_after_search",
          debug: {
            filterSteps,
            userMediaEligibilityDebug,
            forcedPickFallbackUsed,
          },
          finalContentSelection: {
            enabled: false,
            skipped: true,
            reason: "no_sendable_items_after_search",
            raw: null,
            result: null,
            candidates: [],
          },
          finalSelectedItem: null,
          finalSelectedBundle: null,
          sellingMessage: null,
          sellingMessageRaw: null,
        },
        sellable,
      });
    }

    
    const finalContentSelectionTopN = Math.min(
      20,
      Math.max(
        1,
        Number(
          body.finalContentSelectionTopN ??
            body.options?.finalContentSelectionTopN ??
            10
        ) || 10
      )
    );

    /////////////////
    const candidateSourceItems = sendableSearchItems;

    const bundleFilterResult =
      requireBundled
        ? await filterItemsWithAvailableBundles({
            supabase,
            items: candidateSourceItems,
            creatorId: context.creatorOnlyfansAccountId,
            sessionName: context.sessionName,
            userId,
          })
        : {
            validPairs: candidateSourceItems.map((item: any) => ({
              item,
              bundleResult: null,
            })),
            discardedItems: [],
          };

    const validFinalItemBundlePairs = bundleFilterResult.validPairs;

    const bundleFilterStep = buildFilterStep({
      step: "bundle_availability_filter",
      inputCount: candidateSourceItems.length,
      keptItems: validFinalItemBundlePairs.map((pair: any) => pair.item),
      discardedItems: bundleFilterResult.discardedItems,
    });

    filterSteps.push(bundleFilterStep);

    logStep("filter_bundle_availability_done", {
      enabled: requireBundled,
      inputCount: bundleFilterStep.inputCount,
      keptCount: bundleFilterStep.keptCount,
      discardedCount: bundleFilterStep.discardedCount,
    });

    if (
      tasks.searchContent &&
      tasks.suggestContent &&
      requireBundled &&
      validFinalItemBundlePairs.length === 0
    ) {
      logStep("stop_no_available_bundles_after_search", {
        filterSteps,
      });

      return NextResponse.json({
        ok: true,
        success: true,
        context: {
          ...context,
          messages: normalizedMessages,
        },
        options: body.options ?? {},
        tasks,
        taskLlms,
        analysis: {
          shouldSell,
          shouldSellRaw,
          commercialIntent,
          commercialIntentRaw,
          explicitLevel,
          explicitLevelRaw,
          activationResults,
          rawTags,
          tagPriorityRaw: tagPriority.raw,
          tagPriorityResult: tagPriority.rawResult,
          prioritizedTags: tagPriority.tags,
          priority1Tags: tagPriority.priority1,
          priority2Tags: tagPriority.priority2,
          priority3Tags: tagPriority.priority3,
          stopReason: "no_available_bundles_after_search",
          debug: {
            filterSteps,
            userMediaEligibilityDebug,
          },
          finalContentSelection: {
            enabled: false,
            skipped: true,
            reason: "no_available_bundles_after_search",
            raw: null,
            result: null,
            candidates: [],
          },
          finalSelectedItem: null,
          finalSelectedBundle: null,
          sellingMessage: null,
          sellingMessageRaw: null,
        },
        sellable,
      });
    }
    /////////////////

    const finalSelectionStartedAt = nowMs();

    type ForcedPickRecoveryReason =
      | "llm_error"
      | "missing_selected_id"
      | "selected_id_not_in_candidate_set"
      | "final_selection_disabled"
      | "no_llm_candidates";

    let forcedPickSelectionSource:
      | "task"
      | "forced_pick_llm_selection"
      | "forced_pick_random_recovery" = "task";

    let forcedPickRecoveryReason: ForcedPickRecoveryReason | null = null;
    let forcedPickTaskError: string | null = null;
    let forcedPickLlmSelectedId: string | null = null;

    /*
    * For a forced pick, randomize the eligible item/bundle pairs first
    * and expose at most 10 of them to the final selection task.
    *
    * For a normal search, preserve the existing ordered candidates.
    */
    const finalSelectionPairs = forcedPickFallbackUsed
      ? shuffleArray(validFinalItemBundlePairs).slice(
          0,
          Math.min(10, finalContentSelectionTopN)
        )
      : validFinalItemBundlePairs;

    const filteredSellableForFinalSelection = {
      ...sellable,
      result: {
        ...(sellable?.result ?? {}),
        items: finalSelectionPairs.map((pair: any) => pair.item),
      },
    };

    const finalContentSelectionCandidates =
      sellable && tasks.finalContentSelection
        ? buildFinalContentSelectionCandidates({
            sellable: filteredSellableForFinalSelection,
            topN: forcedPickFallbackUsed
              ? Math.min(10, finalContentSelectionTopN)
              : finalContentSelectionTopN,
          })
        : [];

    const finalSelectionCandidateIds =
      finalContentSelectionCandidates.map((candidate: any) =>
        String(candidate.id)
      );

    const finalSelectionCandidateIdSet = new Set(
      finalSelectionCandidateIds
    );

    const forcedPickCandidatePairs = forcedPickFallbackUsed
      ? finalSelectionPairs.filter((pair: any) =>
          finalSelectionCandidateIdSet.has(
            getSearchItemId(pair.item)
          )
        )
      : [];

    logStep("final_selection_start", {
      enabled:
        tasks.finalContentSelection &&
        tasks.searchContent &&
        tasks.suggestContent,
      topN: forcedPickFallbackUsed
        ? Math.min(10, finalContentSelectionTopN)
        : finalContentSelectionTopN,
      candidateCount: finalContentSelectionCandidates.length,
      candidateIds: finalSelectionCandidateIds,
      forcedPickFallbackUsed,
    });

    if (forcedPickFallbackUsed) {
      logStep("forced_pick_candidates_prepared", {
        totalEligiblePairs: validFinalItemBundlePairs.length,
        randomizedPairCount: finalSelectionPairs.length,
        llmCandidateCount: finalContentSelectionCandidates.length,
        candidateIds: finalSelectionCandidateIds,
        mediaType: commercialIntent?.media_type ?? null,
        explicitMin: explicitLevel?.min_level ?? null,
        explicitMax: explicitLevel?.max_level ?? null,
      });
    }

    let finalContentSelectionTask: any = null;

    if (
      tasks.finalContentSelection &&
      tasks.searchContent &&
      tasks.suggestContent &&
      finalContentSelectionCandidates.length > 0
    ) {
      try {
        if (forcedPickFallbackUsed) {
          logStep("forced_pick_llm_selection_start", {
            taskId: "MEDIA_CHAT_FINAL_CONTENT_SELECTION",
            candidateCount: finalContentSelectionCandidates.length,
            candidateIds: finalSelectionCandidateIds,
          });
        }

        finalContentSelectionTask =
          await runFinalContentSelection({
            state,
            candidates: finalContentSelectionCandidates,
            tagPriority,
            commercialIntent,
            explicitLevel,
            topN: forcedPickFallbackUsed
              ? Math.min(10, finalContentSelectionTopN)
              : finalContentSelectionTopN,
            llm: taskLlms.finalContentSelection,
          });
      } catch (error) {
        if (!forcedPickFallbackUsed) {
          throw error;
        }

        forcedPickTaskError =
          error instanceof Error
            ? error.message
            : String(error);

        forcedPickRecoveryReason = "llm_error";

        logStep("forced_pick_llm_selection_error", {
          candidateIds: finalSelectionCandidateIds,
          error: forcedPickTaskError,
        });
      }
    } else {
      finalContentSelectionTask = {
        enabled: false,
        skipped: true,
        reason: tasks.finalContentSelection
          ? "no_usable_candidates"
          : "disabled",
        raw: null,
        result: null,
        candidates: finalContentSelectionCandidates,
      };

      if (forcedPickFallbackUsed) {
        forcedPickRecoveryReason =
          tasks.finalContentSelection
            ? "no_llm_candidates"
            : "final_selection_disabled";

        logStep("forced_pick_llm_selection_skipped", {
          candidateIds: finalSelectionCandidateIds,
          reason: forcedPickRecoveryReason,
        });
      }
    }

    let finalContentSelection: any = finalContentSelectionTask;

    if (forcedPickFallbackUsed) {
      forcedPickLlmSelectedId = normalizeString(
        finalContentSelectionTask?.result?.selected_id ??
          finalContentSelectionTask?.result?.selectedId ??
          finalContentSelectionTask?.result?.id
      );

      const llmSelectedPair = forcedPickLlmSelectedId
        ? forcedPickCandidatePairs.find(
            (pair: any) =>
              getSearchItemId(pair.item) ===
              forcedPickLlmSelectedId
          ) ?? null
        : null;

      let finalForcedPickPair = llmSelectedPair;

      if (llmSelectedPair) {
        forcedPickSelectionSource =
          "forced_pick_llm_selection";

        logStep("forced_pick_llm_selection_valid", {
          selectedId: forcedPickLlmSelectedId,
          candidateIds: finalSelectionCandidateIds,
          originalMatchQuality:
            finalContentSelectionTask?.result?.match_quality ??
            finalContentSelectionTask?.result?.matchQuality ??
            null,
        });
      } else {
        if (!forcedPickRecoveryReason) {
          forcedPickRecoveryReason =
            forcedPickLlmSelectedId
              ? "selected_id_not_in_candidate_set"
              : "missing_selected_id";
        }

        if (forcedPickLlmSelectedId) {
          logStep("forced_pick_llm_selection_invalid_id", {
            selectedId: forcedPickLlmSelectedId,
            candidateIds: finalSelectionCandidateIds,
            reason: forcedPickRecoveryReason,
          });
        } else {
          logStep("forced_pick_llm_selection_missing_id", {
            candidateIds: finalSelectionCandidateIds,
            taskResult:
              finalContentSelectionTask?.result ?? null,
            reason: forcedPickRecoveryReason,
          });
        }

        /*
        * Prefer the exact candidates sent to the LLM.
        * If none had usable summaries, recover from the same randomized
        * group of at most 10 eligible item/bundle pairs.
        */
        const randomRecoveryPairs =
          forcedPickCandidatePairs.length > 0
            ? forcedPickCandidatePairs
            : finalSelectionPairs;

        finalForcedPickPair =
          pickRandomArrayItem(randomRecoveryPairs);

        forcedPickSelectionSource =
          "forced_pick_random_recovery";

        logStep("forced_pick_random_recovery", {
          selectedId: finalForcedPickPair
            ? getSearchItemId(finalForcedPickPair.item)
            : null,
          candidateIds: randomRecoveryPairs.map(
            (pair: any) => getSearchItemId(pair.item)
          ),
          recoveryReason: forcedPickRecoveryReason,
          taskError: forcedPickTaskError,
        });
      }

      const finalForcedPickItemId =
        finalForcedPickPair
          ? getSearchItemId(finalForcedPickPair.item)
          : "";

      const taskUserRequestSummary = normalizeString(
        finalContentSelectionTask?.result?.user_request_summary ??
          finalContentSelectionTask?.result?.userRequestSummary
      );

      const forcedPickResult = finalForcedPickItemId
        ? {
            selected_id: finalForcedPickItemId,
            match_quality: "forced_pick",
            user_request_summary:
              taskUserRequestSummary ||
              normalizeString(state?.global?.message) ||
              "No eligible content matched the requested tags, so a fallback eligible item was selected.",
          }
        : null;

      finalContentSelection = {
        enabled: true,
        skipped: false,
        reason: forcedPickResult
          ? null
          : "forced_pick_recovery_failed",
        synthetic: true,
        source: forcedPickSelectionSource,
        raw: finalContentSelectionTask?.raw ?? null,
        taskResult:
          finalContentSelectionTask?.result ?? null,
        result: forcedPickResult,
        candidates: finalContentSelectionCandidates,
        debug: {
          candidateIds: finalSelectionCandidateIds,
          llmSelectedId: forcedPickLlmSelectedId || null,
          selectionSource: forcedPickSelectionSource,
          recoveryReason: forcedPickRecoveryReason,
          taskError: forcedPickTaskError,
        },
      };
    }

    logStep("final_selection_done", {
      enabled: finalContentSelection.enabled,
      skipped: finalContentSelection.skipped,
      elapsedMs: nowMs() - finalSelectionStartedAt,
      totalElapsedMs: nowMs() - requestStartedAt,
      candidateCount: finalContentSelectionCandidates.length,
      candidateIds: finalSelectionCandidateIds,
      selectedId:
        finalContentSelection?.result?.selected_id ??
        finalContentSelection?.result?.selectedId ??
        finalContentSelection?.result?.id ??
        null,
      matchQuality:
        finalContentSelection?.result?.match_quality ??
        finalContentSelection?.result?.matchQuality ??
        null,
      userRequestSummary:
        finalContentSelection?.result?.user_request_summary ??
        finalContentSelection?.result?.userRequestSummary ??
        null,
      forcedPickFallbackUsed,
      selectionSource: forcedPickSelectionSource,
      forcedPickRecoveryReason,
      forcedPickTaskError,
      forcedPickLlmSelectedId,
    });

    const selectedFinalContentId = normalizeString(
      finalContentSelection?.result?.selected_id ??
        finalContentSelection?.result?.selectedId ??
        finalContentSelection?.result?.id
    );

    const selectedPrevalidatedPair = selectedFinalContentId
      ? validFinalItemBundlePairs.find(
          (pair: any) => getSearchItemId(pair.item) === selectedFinalContentId
        ) ?? null
      : null;

    const selectedFinalItem =
      selectedPrevalidatedPair?.item ??
      (selectedFinalContentId
        ? (sellable?.result?.items ?? []).find(
            (item: any) => getSearchItemId(item) === selectedFinalContentId
          ) ?? null
        : null);

    const selectedFinalBundle =
      requireBundled && selectedFinalItem
        ? selectedPrevalidatedPair?.bundleResult ??
          await loadBundleForSelectedItem({
            supabase,
            selectedItem: selectedFinalItem,
            creatorId: context.creatorOnlyfansAccountId,
            sessionName: context.sessionName,
            userId,
          })
        : {
            enabled: false,
            skipped: true,
            reason: requireBundled
              ? "missing_selected_final_item"
              : "require_bundled_disabled",
            selectedMediaContentAnalysisId: null,
            candidateBundleCount: 0,
            candidateBundleIds: [],
            purchasedBundleIds: [],
            availableBundleIds: [],
            bundle: null,
            items: [],
          };

    logStep("selected_bundle_done", {
      selectedBundleId: selectedFinalBundle?.bundle?.id ?? null,
      selectedBundleItemCount: Array.isArray(selectedFinalBundle?.items)
        ? selectedFinalBundle.items.length
        : 0,
      candidateBundleCount: selectedFinalBundle?.candidateBundleCount ?? 0,
      purchasedBundleIds: selectedFinalBundle?.purchasedBundleIds ?? [],
      availableBundleIds: selectedFinalBundle?.availableBundleIds ?? [],
    });

    const selectedContentForSellingMessage =
      tasks.sellingMessage
        ? buildSelectedContentForSellingMessage({
            selectedFinalItem,
            selectedFinalBundle,
          })
        : null;

    const sellingMessageStartedAt = nowMs();

    logStep("selling_message_start", {
      enabled: tasks.sellingMessage,
      hasSelectedContent: Boolean(selectedContentForSellingMessage),
      selectedContentId:
        selectedContentForSellingMessage?.bundle_id ??
        selectedContentForSellingMessage?.id ??
        selectedContentForSellingMessage?.media_content_analysis_id ??
        null,
    });

    const sellingMessageRaw =
      tasks.sellingMessage && selectedContentForSellingMessage
        ? await runSellingTask({
            state,
            selectedContent: selectedContentForSellingMessage,
            shouldSell,
            llm: taskLlms.sellingMessage,
          })
        : null;

    const sellingMessage = sellingMessageRaw
      ? unwrapTaskResult(sellingMessageRaw)
      : null;

    logStep("selling_message_done", {
      enabled: tasks.sellingMessage,
      elapsedMs: nowMs() - sellingMessageStartedAt,
      totalElapsedMs: nowMs() - requestStartedAt,
      hasResult: Boolean(sellingMessage),
    });

    logStep("done", {
      totalElapsedMs: nowMs() - requestStartedAt,
    });
    
    return NextResponse.json({
      ok: true,
      success: true,
      context: {
        ...context,
        messages: normalizedMessages,
      },
      options: body.options ?? {},
      tasks,
      taskLlms,
      analysis: {
        shouldSell,
        shouldSellRaw,

        commercialIntent,
        commercialIntentRaw,

        explicitLevel,
        explicitLevelRaw,

        activationResults,
        rawTags,

        tagPriorityRaw: tagPriority.raw,
        tagPriorityResult: tagPriority.rawResult,
        prioritizedTags: tagPriority.tags,
        priority1Tags: tagPriority.priority1,
        priority2Tags: tagPriority.priority2,
        priority3Tags: tagPriority.priority3,

        finalContentSelection,
        finalSelectedItem: selectedFinalItem,
        finalSelectedBundle: selectedFinalBundle,

        sellingMessage,
        sellingMessageRaw,
        debug: {
          filterSteps,
          userMediaEligibilityDebug,
          forcedPick: {
            used: forcedPickFallbackUsed,
            candidateIds: finalSelectionCandidateIds,
            candidateCount: finalSelectionCandidateIds.length,
            llmSelectedId: forcedPickLlmSelectedId,
            finalSelectedId:
              finalContentSelection?.result?.selected_id ??
              finalContentSelection?.result?.selectedId ??
              finalContentSelection?.result?.id ??
              null,
            selectionSource: forcedPickSelectionSource,
            recoveryReason: forcedPickRecoveryReason,
            taskError: forcedPickTaskError,
          },
        },     
      },
      sellable,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    console.error("[sellable-library/chat-search-v2]", error);

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