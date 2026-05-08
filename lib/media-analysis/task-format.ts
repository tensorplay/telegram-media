// lib/media-analysis/task-format.ts

export type ParsedTaskFormat = {
  taxonomyDomain: string;
  parentCategory: string;
};

export function isTaskSummaryFormat(format: string | null | undefined): boolean {
  return /^task:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(String(format ?? "").trim());
}

export function parseTaskFormat(format: string): ParsedTaskFormat {
  const raw = String(format ?? "").trim();
  const match = raw.match(/^task:([^:]+):([^:]+)$/);

  if (!match) {
    throw new Error(`Invalid task format: ${raw}`);
  }

  return {
    taxonomyDomain: match[1],
    parentCategory: match[2],
  };
}