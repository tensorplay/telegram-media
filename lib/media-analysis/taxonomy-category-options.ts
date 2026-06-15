import { parseTaskFormat } from "@/lib/media-analysis/task-format";

export type SupabaseClientLike = {
  from: (table: string) => any;
};

export type TaxonomyCategoryOption = {
  label: string;
  taskFormat: string;
  parentCategory: string;
  taxonomyDomain: string;
  description: string | null;
  tags: Array<{
    id?: string | number;
    category: string;
    name: string;
    description: string | null;
  }>;
};

type TaxonomyRow = {
  id: number;
  category: string;
  description: string | null;
};

type TaxonomyParentLinkRow = {
  item_id: number;
  parent_category: string;
};

export function normalizeTaskFormat(value: unknown, defaultDomain = "ADULT") {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return "";
  }

  if (raw.startsWith("task:")) {
    return raw;
  }

  const domainPrefix = `${defaultDomain}:`;
  const category = raw
    .replace(new RegExp(`^${domainPrefix}`, "i"), "")
    .trim()
    .toUpperCase();

  return `task:${defaultDomain}:${category}`;
}

export function titleCaseTaxonomyCategory(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function getTaxonomyCategoryOptions({
  supabase,
  domain,
}: {
  supabase: SupabaseClientLike;
  domain: string;
}): Promise<TaxonomyCategoryOption[]> {
  const normalizedDomain = String(domain || "ADULT").trim().toUpperCase();

  const { data: linksRaw, error: linksError } = await supabase
    .from("media_taxonomy_parents")
    .select("item_id, parent_category")
    .eq("taxonomy_domain", normalizedDomain);

  const links = (linksRaw ?? []) as TaxonomyParentLinkRow[];

  if (linksError) {
    throw new Error(linksError.message);
  }

  const parentCategories = Array.from(
    new Set(
      (links ?? [])
        .map((row) => String(row.parent_category || "").trim().toUpperCase())
        .filter(Boolean)
    )
  );

  if (parentCategories.length === 0) {
    return [];
  }

  const linkedItemIds = Array.from(
    new Set(
      links
        .map((row) => Number(row.item_id))
        .filter((id) => Number.isFinite(id))
    )
  );

  const { data: parentRowsRaw, error: parentRowsError } = await supabase
    .from("media_taxonomy")
    .select("id, category, description")
    .eq("taxonomy_domain", normalizedDomain)
    .eq("is_active", true)
    .in("category", parentCategories)
    .order("category", { ascending: true });

  if (parentRowsError) {
    throw new Error(parentRowsError.message);
  }

  const { data: childRowsRaw, error: childRowsError } = await supabase
    .from("media_taxonomy")
    .select("id, category, description")
    .eq("taxonomy_domain", normalizedDomain)
    .eq("is_active", true)
    .in("id", linkedItemIds)
    .order("category", { ascending: true });

  if (childRowsError) {
    throw new Error(childRowsError.message);
  }

  const taxonomyRows = Array.from(
    new Map(
      [...(parentRowsRaw ?? []), ...(childRowsRaw ?? [])]
        .map((row) => [Number(row.id), row as TaxonomyRow])
    ).values()
  );

  const rowsById = new Map(
    taxonomyRows.map((row) => [Number(row.id), row])
  );

  const childrenByParent = new Map<string, TaxonomyRow[]>();

  for (const link of links) {
    const parentCategory = String(link.parent_category || "")
      .trim()
      .toUpperCase();

    const child = rowsById.get(Number(link.item_id));

    if (!parentCategory || !child) {
      continue;
    }

    if (!childrenByParent.has(parentCategory)) {
      childrenByParent.set(parentCategory, []);
    }

    childrenByParent.get(parentCategory)?.push(child);
  }

  const parentRows = taxonomyRows.filter((row) =>
    parentCategories.includes(String(row.category || "").trim().toUpperCase())
  );

  return parentRows.map((parent) => {
    const parentCategory = String(parent.category || "").trim().toUpperCase();

    const childRows = childrenByParent.get(parentCategory) ?? [];

    return {
      label: titleCaseTaxonomyCategory(parentCategory),
      taskFormat: `task:${normalizedDomain}:${parentCategory}`,
      parentCategory,
      taxonomyDomain: normalizedDomain,
      description: parent.description ?? null,
      tags: childRows
        .map((child) => {
          const category = String(child.category || "").trim().toUpperCase();

          return {
            id: Number(child.id),
            category,
            name: category,
            description: child.description ?? null,
          };
        })
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
  });
}

export async function validateTaxonomyTaskFormat({
  supabase,
  taskFormat,
}: {
  supabase: SupabaseClientLike;
  taskFormat: string;
}) {
  const parsedTask = parseTaskFormat(taskFormat);

  const taxonomyDomain = String(parsedTask.taxonomyDomain || "")
    .trim()
    .toUpperCase();

  const parentCategory = String(parsedTask.parentCategory || "")
    .trim()
    .toUpperCase();

  if (!taxonomyDomain || !parentCategory) {
    return {
      valid: false,
      taxonomyDomain,
      parentCategory,
      options: [] as TaxonomyCategoryOption[],
      error: `Invalid taskFormat: ${taskFormat}`,
    };
  }

  const options = await getTaxonomyCategoryOptions({
    supabase,
    domain: taxonomyDomain,
  });

  const valid = options.some(
    (option) =>
      option.taxonomyDomain === taxonomyDomain &&
      option.parentCategory === parentCategory
  );

  return {
    valid,
    taxonomyDomain,
    parentCategory,
    options,
    error: valid ? null : `Unsupported taskFormat: ${taskFormat}`,
  };
}