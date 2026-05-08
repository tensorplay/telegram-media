// lib/media-analysis/run-taxonomy-analysis.ts

import { analyzeMediaWithCustomPrompt } from "@/lib/gemini";
import { parseTaskFormat } from "@/lib/media-analysis/task-format";
import { resolveTaskPromptFromFormat } from "@/lib/media-analysis/task-prompt-resolver";

export type RunTaxonomyTaskInput = {
  taskFormat: string;
  mediaBytes: Buffer;
  contentType: string;
};

export type ExecuteTaxonomyTaskInput = {
  mediaBytes: Buffer;
  contentType: string;
  prompt: string;
  taskFormat: string;
};

export type ExecuteTaxonomyTask = (
  input: ExecuteTaxonomyTaskInput
) => Promise<unknown>;

export type TaxonomyTaskResult = {
  taskFormat: string;
  taxonomyDomain: string;
  parentCategory: string;
  prompt: string;
  result: unknown;
};

function parseJsonIfPossible(value: unknown): unknown {
  if (value == null) return null;

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    return value;
  }
}

async function defaultExecuteTaxonomyTask(
  input: ExecuteTaxonomyTaskInput
): Promise<unknown> {
  const { mediaBytes, contentType, prompt } = input;

  return analyzeMediaWithCustomPrompt(mediaBytes, contentType, prompt);
}

/**
 * Resolves a taxonomy task prompt and executes it using Gemini by default.
 *
 * This function does not persist anything.
 * It only prepares the prompt and delegates execution.
 */
export async function runTaxonomyTask(
  input: RunTaxonomyTaskInput,
  executeTaxonomyTask: ExecuteTaxonomyTask = defaultExecuteTaxonomyTask
): Promise<TaxonomyTaskResult> {
  const { taskFormat, mediaBytes, contentType } = input;

  const { taxonomyDomain, parentCategory } = parseTaskFormat(taskFormat);
  const prompt = await resolveTaskPromptFromFormat(taskFormat);

  const rawResult = await executeTaxonomyTask({
    mediaBytes,
    contentType,
    prompt,
    taskFormat,
  });

  return {
    taskFormat,
    taxonomyDomain,
    parentCategory,
    prompt,
    result: parseJsonIfPossible(rawResult),
  };
}

/**
 * Runs multiple taxonomy tasks sequentially.
 *
 * Sequential execution is intentional for now:
 * - simpler control flow
 * - easier debugging
 * - safer while integrating into the existing pipeline
 */
export async function runTaxonomyTasks(
  taskFormats: string[],
  mediaBytes: Buffer,
  contentType: string,
  executeTaxonomyTask: ExecuteTaxonomyTask = defaultExecuteTaxonomyTask
): Promise<TaxonomyTaskResult[]> {
  const results: TaxonomyTaskResult[] = [];

  for (const taskFormat of taskFormats) {
    const result = await runTaxonomyTask(
      {
        taskFormat,
        mediaBytes,
        contentType,
      },
      executeTaxonomyTask
    );

    results.push(result);
  }

  return results;
}