// lib/media-analysis/task-prompt-resolver.ts

import { createClient } from "@/lib/supabase/server";
import { parseTaskFormat } from "@/lib/media-analysis/task-format";

type TaxonomyChildRow = {
  id: string | number;
  category: string;
  description: string | null;
};

type FlowInstructionRow = {
  instruction_text: string | null;
};

type ParentTaxonomyRow = {
  category: string;
  description: string | null;
};

type ParentLinkRow = {
  item_id: string | number;
};

/**
 * Builds the markdown block injected into the base prompt template.
 *
 * Example:
 * - **NONE**: No explicit sexual content
 * - **LOW**: Mild suggestive content
 */
export function buildCategoryDefinitions(children: TaxonomyChildRow[]): string {
  if (!children.length) return "";

  return children
    .map((item) => {
      const description = String(item.description ?? "").trim();
      return `- **${item.category}**: ${description}`;
    })
    .join("\n");
}

/**
 * Resolves the final prompt dynamically from:
 * - flow_instructions.instruction_text
 * - media_taxonomy (parent)
 * - media_taxonomy_parents (relations)
 * - media_taxonomy (active children)
 *
 * Replaces these placeholders:
 * - <category_name>
 * - <category_description>
 * - <category_definitions>
 * - <labels_string>
 *
 * This file only resolves prompts.
 * It does not call Gemini, analyze media, or persist results.
 */
export async function resolveTaskPromptFromFormat(format: string): Promise<string> {
  const { taxonomyDomain, parentCategory } = parseTaskFormat(format);
  const instructionName = "VISION_EXPLICIT_CATEGORY_ANALYSIS_DEFAULT";

  const supabase = await createClient();

  // 1) Load the base instruction template
  const { data: instructionRow, error: instructionError } = await supabase
    .from("flow_instructions")
    .select("instruction_text")
    .eq("instruction_name", instructionName)
    .maybeSingle<FlowInstructionRow>();

  if (instructionError) {
    throw new Error(
      `Failed to load flow instruction "${instructionName}": ${instructionError.message}`
    );
  }

  if (!instructionRow?.instruction_text) {
    throw new Error(`Flow instruction not found: ${instructionName}`);
  }

  // 2) Load the active parent taxonomy node
  const { data: parentRow, error: parentError } = await supabase
    .from("media_taxonomy")
    .select("category, description")
    .eq("taxonomy_domain", taxonomyDomain)
    .eq("category", parentCategory)
    .eq("is_active", true)
    .maybeSingle<ParentTaxonomyRow>();

  if (parentError) {
    throw new Error(
      `Failed to load parent taxonomy "${taxonomyDomain}:${parentCategory}": ${parentError.message}`
    );
  }

  if (!parentRow) {
    throw new Error(`Parent taxonomy not found: ${taxonomyDomain}:${parentCategory}`);
  }

  // 3) Load parent -> children relations
  const { data: childLinks, error: childLinksError } = await supabase
    .from("media_taxonomy_parents")
    .select("item_id")
    .eq("taxonomy_domain", taxonomyDomain)
    .eq("parent_category", parentCategory)
    .returns<ParentLinkRow[]>();

  if (childLinksError) {
    throw new Error(`Failed to load taxonomy children links: ${childLinksError.message}`);
  }

  const itemIds = (childLinks ?? []).map((row) => row.item_id);

  // 4) Load active child categories
  let children: TaxonomyChildRow[] = [];

  if (itemIds.length > 0) {
    const { data: childRows, error: childrenError } = await supabase
      .from("media_taxonomy")
      .select("id, category, description")
      .in("id", itemIds)
      .eq("taxonomy_domain", taxonomyDomain)
      .eq("is_active", true)
      .order("id", { ascending: true })
      .returns<TaxonomyChildRow[]>();

    if (childrenError) {
      throw new Error(`Failed to load taxonomy children: ${childrenError.message}`);
    }

    children = childRows ?? [];
  }

  if (!children.length) {
    throw new Error(
      `No active child categories found for ${taxonomyDomain}:${parentCategory}`
    );
  }

  // 5) Build replacement values
  const labelsString = children.map((child) => `"${child.category}"`).join(", ");
  const categoryDefinitions = buildCategoryDefinitions(children);

  // 6) Render the final prompt
  return instructionRow.instruction_text
    .replaceAll("<category_name>", parentRow.category)
    .replaceAll("<category_description>", String(parentRow.description ?? ""))
    .replaceAll("<category_definitions>", categoryDefinitions)
    .replaceAll("<labels_string>", labelsString);
}