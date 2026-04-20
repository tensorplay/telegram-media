// lib/media-analysis/run-taxonomy-pipeline.ts

import {
  runTaxonomyTask,
  type TaxonomyTaskResult,
} from "@/lib/media-analysis/run-taxonomy-analysis";

const SOLO_PARTICIPANT_DYNAMICS = new Set([
  "SOLO_FEMALE",
  "SOLO_MALE",
  "SOLO_TRANS",
]);

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
  participantsDynamics: string | null;
  isSexual: boolean;
};

type ParsedTaskCategories = {
  confirmed: string[];
  probable: string[];
};

function normalizeCategoryValues(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  return values
    .map((value) => String(value ?? "").trim().toUpperCase())
    .filter(Boolean);
}

function extractTaskCategories(task: TaxonomyTaskResult): ParsedTaskCategories {
  const result =
    task.result && typeof task.result === "object"
      ? (task.result as Record<string, unknown>)
      : {};

  return {
    confirmed: normalizeCategoryValues(result.confirmed),
    probable: normalizeCategoryValues(result.probable),
  };
}

function getHighestExplicitnessLevel(
  explicitTask: TaxonomyTaskResult
): ExplicitnessLevel {
  const { confirmed, probable } = extractTaskCategories(explicitTask);

  const pickHighest = (values: string[]): ExplicitnessLevel => {
    let best: ExplicitnessLevel = null;
    let bestScore = -1;

    for (const value of values) {
      const score = EXPLICITNESS_PRIORITY[value];
      if (score == null) continue;

      if (score > bestScore) {
        best = value as ExplicitnessLevel;
        bestScore = score;
      }
    }

    return best;
  };

  return pickHighest(confirmed) ?? pickHighest(probable) ?? null;
}

function pickBestCategory(task: TaxonomyTaskResult): string | null {
  const { confirmed, probable } = extractTaskCategories(task);
  return confirmed[0] ?? probable[0] ?? null;
}

function computeIsSexual(
  highestExplicitnessLevel: ExplicitnessLevel
): boolean {
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
  if (!taskFormats.length) return [];

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

/**
 * Runs the taxonomy pipeline using the same execution order as the legacy flow:
 *
 * 1. Gate tasks in parallel:
 *    - ADULT:EXPLICIT_LEVEL
 *    - ADULT:PARTICIPANTS_DYNAMICS
 *
 * 2. Universal tasks in parallel:
 *    - ADULT:LOCATION
 *    - ADULT:CAMERA_STYLE
 *    - ADULT:FACE_ATTRIBUTES
 *    - ADULT:PERFORMER_IDENTITY_ATTRIBUTES
 *
 * 3. Conditional branch based on explicitness level and participants dynamics.
 *
 * This pipeline intentionally does not run the existing summary/tag analysis.
 * The current baseline analysis in lib/analyze.ts remains unchanged.
 */
export async function runTaxonomyPipeline(
  mediaBytes: Buffer,
  contentType: string
): Promise<RunTaxonomyPipelineOutput> {
  const allTasks: TaxonomyTaskResult[] = [];

  const gateTasks = await runTaskGroup(
    [
      "task:ADULT:EXPLICIT_LEVEL",
      "task:ADULT:PARTICIPANTS_DYNAMICS",
    ],
    mediaBytes,
    contentType
  );

  allTasks.push(...gateTasks);

  const explicitLevelTask = gateTasks.find(
    (task) => task.taskFormat === "task:ADULT:EXPLICIT_LEVEL"
  );
  const participantsDynamicsTask = gateTasks.find(
    (task) => task.taskFormat === "task:ADULT:PARTICIPANTS_DYNAMICS"
  );

  if (!explicitLevelTask) {
    throw new Error(
      'runTaxonomyPipeline: missing result for "task:ADULT:EXPLICIT_LEVEL"'
    );
  }

  if (!participantsDynamicsTask) {
    throw new Error(
      'runTaxonomyPipeline: missing result for "task:ADULT:PARTICIPANTS_DYNAMICS"'
    );
  }

  const highestExplicitnessLevel =
    getHighestExplicitnessLevel(explicitLevelTask);
  const participantsDynamics = pickBestCategory(participantsDynamicsTask);
  const isSexual = computeIsSexual(highestExplicitnessLevel);

  const universalTasks = await runTaskGroup(
    [
      "task:ADULT:LOCATION",
      "task:ADULT:CAMERA_STYLE",
      "task:ADULT:FACE_ATTRIBUTES",
      "task:ADULT:PERFORMER_IDENTITY_ATTRIBUTES",
    ],
    mediaBytes,
    contentType
  );

  allTasks.push(...universalTasks);

  if (highestExplicitnessLevel === "NONE") {
    const noneTasks = await runTaskGroup(
      [
        "task:ADULT:PERFORMER_VISUAL_ATTRIBUTES",
        "task:ADULT:PERFORMER_PHYSICAL_TRAITS",
      ],
      mediaBytes,
      contentType
    );

    allTasks.push(...noneTasks);
  } else if (highestExplicitnessLevel === "LOW") {
    const lowTasks = await runTaskGroup(
      [
        "task:ADULT:PERFORMER_VISUAL_ATTRIBUTES",
        "task:ADULT:PERFORMER_PHYSICAL_TRAITS",
        "task:ADULT:ACTIVITIES",
      ],
      mediaBytes,
      contentType
    );

    allTasks.push(...lowTasks);
  } else if (
    highestExplicitnessLevel === "MEDIUM" ||
    highestExplicitnessLevel === "HIGH" ||
    highestExplicitnessLevel === "EXTREME"
  ) {
    const explicitCoreTasks = await runTaskGroup(
      [
        "task:ADULT:PERFORMER_VISUAL_ATTRIBUTES",
        "task:ADULT:PERFORMER_PHYSICAL_TRAITS",
        "task:ADULT:BODY_STATS",
      ],
      mediaBytes,
      contentType
    );

    allTasks.push(...explicitCoreTasks);

    if (
      participantsDynamics &&
      SOLO_PARTICIPANT_DYNAMICS.has(participantsDynamics)
    ) {
      const soloTasks = await runTaskGroup(
        [
          "task:ADULT:ACTIVITIES",
          "task:ADULT:TOYS_FLUIDS",
        ],
        mediaBytes,
        contentType
      );

      allTasks.push(...soloTasks);
    } else {
      const multiTasks = await runTaskGroup(
        [
          "task:ADULT:ACTIVITIES",
          "task:ADULT:POSITIONS",
          "task:ADULT:TOYS_FLUIDS",
          "task:ADULT:FETISH",
        ],
        mediaBytes,
        contentType
      );

      allTasks.push(...multiTasks);
    }
  }

  return {
    tasks: allTasks,
    highestExplicitnessLevel,
    participantsDynamics,
    isSexual,
  };
}