// lib/media-analysis/run-taxonomy-pipeline.ts

import { createAdminClient } from "@/lib/supabase/admin";
import {
  runTaxonomyTask,
  type TaxonomyTaskResult,
} from "@/lib/media-analysis/run-taxonomy-analysis";

const TAXONOMY_DOMAIN = "ADULT";

/**
 * Priority scoring used to extract the highest explicitness level found in the media.
 */
const EXPLICITNESS_PRIORITY: Record<string, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  EXTREME: 4,
};

export type ExplicitnessLevel =
  | "NONE"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "EXTREME"
  | null;

export type RunTaxonomyPipelineOutput = {
  tasks: TaxonomyTaskResult[];
  highestExplicitnessLevel: ExplicitnessLevel;
  participantsDynamics: "SOLO_CONTENT" | "MIXED_PARTNERS" | null;
  isSexual: boolean;
  fromCache: boolean;
  skippedTaskKeys: string[];
  executedTaskKeys: string[];
};

export type RunTaxonomyPipelineOptions = {
  skipTaskKeys?: Iterable<string>;
};

type PipelineObjectInput = {
  mediaBytes: Buffer;
  contentType: string;
  skipTaskKeys?: Iterable<string>;
};

type ParsedTaskCategories = {
  confirmed: string[];
  probable: string[];
};

type TaxonomyParentRow = {
  parent_category: string;
  item_id: number;
  taxonomy_domain: string;
};

type TaxonomyRow = {
  id?: number;
  category?: string;
  explicitness_level?: string | null;
};

function normalizeKey(value: string): string {
  return String(value || "").trim().toUpperCase();
}

function normalizeSkipTaskKeys(skipTaskKeys?: Iterable<string>): Set<string> {
  const normalized = new Set<string>();

  if (!skipTaskKeys) {
    return normalized;
  }

  for (const key of skipTaskKeys) {
    const value = normalizeKey(key);

    if (value) {
      normalized.add(value);
    }
  }

  return normalized;
}

function buildTaxonomyKeyFromTaskFormat(taskFormat: string): string {
  const parts = String(taskFormat || "").split(":");

  if (parts.length < 3) {
    return normalizeKey(taskFormat);
  }

  const taxonomyDomain = parts[1];
  const parentCategory = parts[2];

  return `${normalizeKey(taxonomyDomain)}:${normalizeKey(parentCategory)}`;
}

function normalizeCategoryValues(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value ?? "").trim().toUpperCase())
    .filter(Boolean);
}

function extractTaskCategories(task: TaxonomyTaskResult): ParsedTaskCategories {
  const result =
    task.result && typeof task.result === "object" && !Array.isArray(task.result)
      ? (task.result as Record<string, unknown>)
      : {};

  return {
    confirmed: normalizeCategoryValues(result.confirmed),
    probable: normalizeCategoryValues(result.probable),
  };
}

/**
 * Loads the active parent taxonomy categories from Supabase.
 *
 * Each parent category becomes a task format:
 * task:ADULT:<PARENT_CATEGORY>
 */
async function loadActiveTaxonomyTaskFormats(): Promise<string[]> {
  const supabase = createAdminClient();

  const { data: parentLinks, error: parentLinksError } = await supabase
    .from("media_taxonomy_parents")
    .select("parent_category, item_id, taxonomy_domain")
    .eq("taxonomy_domain", TAXONOMY_DOMAIN)
    .returns<TaxonomyParentRow[]>();

  if (parentLinksError) {
    throw new Error(parentLinksError.message);
  }

  const links = parentLinks ?? [];

  if (links.length === 0) {
    return [];
  }

  const parentCategories = [
    ...new Set(
      links
        .map((row) => String(row.parent_category || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];

  const itemIds = [
    ...new Set(
      links
        .map((row) => Number(row.item_id))
        .filter((value) => Number.isFinite(value))
    ),
  ];

  if (parentCategories.length === 0 || itemIds.length === 0) {
    return [];
  }

  const { data: activeParents, error: activeParentsError } = await supabase
    .from("media_taxonomy")
    .select("category")
    .eq("taxonomy_domain", TAXONOMY_DOMAIN)
    .in("category", parentCategories)
    .eq("is_active", true)
    .returns<TaxonomyRow[]>();

  if (activeParentsError) {
    throw new Error(activeParentsError.message);
  }

  const { data: activeChildren, error: activeChildrenError } = await supabase
    .from("media_taxonomy")
    .select("id")
    .eq("taxonomy_domain", TAXONOMY_DOMAIN)
    .in("id", itemIds)
    .eq("is_active", true)
    .returns<TaxonomyRow[]>();

  if (activeChildrenError) {
    throw new Error(activeChildrenError.message);
  }

  const activeParentSet = new Set(
    (activeParents ?? [])
      .map((row) => String(row.category || "").trim().toUpperCase())
      .filter(Boolean)
  );

  const activeChildIdSet = new Set(
    (activeChildren ?? [])
      .map((row) => Number(row.id))
      .filter((value) => Number.isFinite(value))
  );

  const validParentCategories = [
    ...new Set(
      links
        .filter((row) => {
          const parentCategory = String(row.parent_category || "")
            .trim()
            .toUpperCase();

          return (
            activeParentSet.has(parentCategory) &&
            activeChildIdSet.has(Number(row.item_id))
          );
        })
        .map((row) => String(row.parent_category || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ].sort();

  return validParentCategories.map(
    (parentCategory) => `task:${TAXONOMY_DOMAIN}:${parentCategory}`
  );
}

/**
 * Builds the explicitness dictionary from public.media_taxonomy if the
 * explicitness_level column exists.
 *
 * If the column does not exist yet, the function falls back to direct
 * NONE/LOW/MEDIUM/HIGH/EXTREME mapping so the pipeline can still run.
 */
async function loadDynamicExplicitnessMap(): Promise<
  Record<string, ExplicitnessLevel>
> {
  const fallbackMap: Record<string, ExplicitnessLevel> = {
    NONE: "NONE",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    EXTREME: "EXTREME",
  };

  try {
    const supabase = createAdminClient();

    const { data: rows, error } = await supabase
      .from("media_taxonomy")
      .select("category, explicitness_level")
      .eq("taxonomy_domain", TAXONOMY_DOMAIN)
      .returns<TaxonomyRow[]>();

    if (error) {
      throw new Error(error.message);
    }

    const map: Record<string, ExplicitnessLevel> = { ...fallbackMap };

    for (const row of rows ?? []) {
      const category = String(row.category || "").trim().toUpperCase();
      const explicitnessLevel = String(row.explicitness_level || "")
        .trim()
        .toUpperCase();

      if (!category) {
        continue;
      }

      if (
        explicitnessLevel === "NONE" ||
        explicitnessLevel === "LOW" ||
        explicitnessLevel === "MEDIUM" ||
        explicitnessLevel === "HIGH" ||
        explicitnessLevel === "EXTREME"
      ) {
        map[category] = explicitnessLevel;
      }
    }

    return map;
  } catch (error) {
    console.warn(
      "[taxonomy-pipeline] Could not load explicitness_level from media_taxonomy. Falling back to direct explicitness labels.",
      error
    );

    return fallbackMap;
  }
}

/**
 * Dynamic explicitness resolver.
 */
function getHighestExplicitnessLevel(
  allConfirmedTags: string[],
  allProbableTags: string[],
  dynamicExplicitnessMap: Record<string, ExplicitnessLevel>
): ExplicitnessLevel {
  const pickHighest = (values: string[]): ExplicitnessLevel => {
    let best: ExplicitnessLevel = null;
    let bestScore = -1;

    for (const value of values) {
      const assignedLevel = dynamicExplicitnessMap[value] ?? "NONE";
      const score = EXPLICITNESS_PRIORITY[assignedLevel];

      if (score == null) {
        continue;
      }

      if (score > bestScore) {
        best = assignedLevel;
        bestScore = score;
      }
    }

    return best;
  };

  return pickHighest(allConfirmedTags) ?? pickHighest(allProbableTags) ?? "NONE";
}

function determineParticipantsDynamics(
  allConfirmedTags: string[],
  allProbableTags: string[]
): "SOLO_CONTENT" | "MIXED_PARTNERS" | null {
  if (allConfirmedTags.includes("MIXED_PARTNERS")) {
    return "MIXED_PARTNERS";
  }

  if (allConfirmedTags.includes("SOLO_CONTENT")) {
    return "SOLO_CONTENT";
  }

  if (allProbableTags.includes("MIXED_PARTNERS")) {
    return "MIXED_PARTNERS";
  }

  if (allProbableTags.includes("SOLO_CONTENT")) {
    return "SOLO_CONTENT";
  }

  return null;
}

function computeIsSexual(highestExplicitnessLevel: ExplicitnessLevel): boolean {
  return (
    highestExplicitnessLevel === "MEDIUM" ||
    highestExplicitnessLevel === "HIGH" ||
    highestExplicitnessLevel === "EXTREME"
  );
}

async function runTaskGroup(
  taskFormats: string[],
  mediaBytes: Buffer,
  contentType: string
): Promise<TaxonomyTaskResult[]> {
  if (!taskFormats.length) {
    return [];
  }

  return Promise.all(
    taskFormats.map((taskFormat) =>
      runTaxonomyTask({
        taskFormat,
        mediaBytes,
        contentType,
      })
    )
  );
}

async function runTaxonomyPipelineInternal({
  mediaBytes,
  contentType,
  skipTaskKeys,
}: PipelineObjectInput): Promise<RunTaxonomyPipelineOutput> {
  const normalizedSkipTaskKeys = normalizeSkipTaskKeys(skipTaskKeys);

  const allTaskFormats = await loadActiveTaxonomyTaskFormats();

  const executableTaskFormats = allTaskFormats.filter((taskFormat) => {
    const taskKey = buildTaxonomyKeyFromTaskFormat(taskFormat);
    return !normalizedSkipTaskKeys.has(taskKey);
  });

  const skippedTaskKeys = allTaskFormats
    .map((taskFormat) => buildTaxonomyKeyFromTaskFormat(taskFormat))
    .filter((taskKey) => normalizedSkipTaskKeys.has(taskKey));

  const executedTaskKeys = executableTaskFormats.map((taskFormat) =>
    buildTaxonomyKeyFromTaskFormat(taskFormat)
  );

  if (!executableTaskFormats.length) {
    return {
      tasks: [],
      highestExplicitnessLevel: "NONE",
      participantsDynamics: null,
      isSexual: false,
      fromCache: true,
      skippedTaskKeys,
      executedTaskKeys,
    };
  }

  const dynamicExplicitnessMap = await loadDynamicExplicitnessMap();

  const tasksExecuted = await runTaskGroup(
    executableTaskFormats,
    mediaBytes,
    contentType
  );

  const allConfirmedTags: string[] = [];
  const allProbableTags: string[] = [];

  for (const task of tasksExecuted) {
    if (!task) {
      continue;
    }

    const { confirmed, probable } = extractTaskCategories(task);

    allConfirmedTags.push(...confirmed);
    allProbableTags.push(...probable);
  }

  const highestExplicitnessLevel = getHighestExplicitnessLevel(
    allConfirmedTags,
    allProbableTags,
    dynamicExplicitnessMap
  );

  const participantsDynamics = determineParticipantsDynamics(
    allConfirmedTags,
    allProbableTags
  );

  const isSexual = computeIsSexual(highestExplicitnessLevel);

  return {
    tasks: tasksExecuted,
    highestExplicitnessLevel,
    participantsDynamics,
    isSexual,
    fromCache: false,
    skippedTaskKeys,
    executedTaskKeys,
  };
}

/**
 * Runs the taxonomy pipeline using the active taxonomy categories from DB.
 *
 * Supports both call styles:
 *
 * runTaxonomyPipeline(mediaBytes, contentType)
 *
 * runTaxonomyPipeline({
 *   mediaBytes,
 *   contentType,
 *   skipTaskKeys,
 * })
 */
export async function runTaxonomyPipeline(
  mediaBytes: Buffer,
  contentType: string,
  options?: RunTaxonomyPipelineOptions
): Promise<RunTaxonomyPipelineOutput>;

export async function runTaxonomyPipeline(
  input: PipelineObjectInput
): Promise<RunTaxonomyPipelineOutput>;

export async function runTaxonomyPipeline(
  input: Buffer | PipelineObjectInput,
  contentType?: string,
  options: RunTaxonomyPipelineOptions = {}
): Promise<RunTaxonomyPipelineOutput> {
  if (Buffer.isBuffer(input)) {
    if (!contentType) {
      throw new Error("runTaxonomyPipeline: contentType is required");
    }

    return runTaxonomyPipelineInternal({
      mediaBytes: input,
      contentType,
      skipTaskKeys: options.skipTaskKeys,
    });
  }

  return runTaxonomyPipelineInternal(input);
}