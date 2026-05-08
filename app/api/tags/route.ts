import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Bulk tag mutation: add/remove tags across many media files while preserving
 * existing tags. Supports "replace a prefix" (e.g. strip any `status:*` before
 * writing `status:posted`) which is how we model mutually-exclusive lifecycle
 * states on top of the `text[]` column without a schema change.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const mediaIds: unknown = body.mediaIds;
  const addRaw: unknown = body.add;
  const removeRaw: unknown = body.remove;
  const clearPrefixesRaw: unknown = body.clearPrefixes;

  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    return NextResponse.json({ error: "Missing mediaIds" }, { status: 400 });
  }
  const ids = mediaIds.filter((v): v is string => typeof v === "string");
  if (ids.length === 0) {
    return NextResponse.json({ error: "mediaIds must be strings" }, { status: 400 });
  }
  const add = Array.isArray(addRaw)
    ? addRaw.filter((v): v is string => typeof v === "string").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];
  const remove = new Set(
    Array.isArray(removeRaw)
      ? removeRaw
          .filter((v): v is string => typeof v === "string")
          .map((t) => t.trim().toLowerCase())
      : []
  );
  const clearPrefixes = Array.isArray(clearPrefixesRaw)
    ? clearPrefixesRaw
        .filter((v): v is string => typeof v === "string")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
    : [];

  // Fetch current tags for each file in one query and patch them locally
  // before writing back. Supabase has no in-place array edit primitive that
  // respects per-row state, so this read-modify-write is unavoidable.
  const { data: rows, error } = await supabase
    .from("media_files")
    .select("id, ai_tags")
    .in("id", ids);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const updates: { id: string; ai_tags: string[] }[] = [];
  for (const row of rows ?? []) {
    const existing = Array.isArray(row.ai_tags) ? row.ai_tags : [];
    const next: string[] = [];
    const seen = new Set<string>();
    for (const raw of existing) {
      if (typeof raw !== "string") continue;
      const t = raw.trim().toLowerCase();
      if (!t) continue;
      if (remove.has(t)) continue;
      if (clearPrefixes.some((p) => t.startsWith(p))) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      next.push(t);
    }
    for (const t of add) {
      if (!seen.has(t)) {
        seen.add(t);
        next.push(t);
      }
    }
    updates.push({ id: row.id, ai_tags: next });
  }

  const BATCH = 25;
  let updated = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((u) =>
        supabase
          .from("media_files")
          .update({ ai_tags: u.ai_tags })
          .eq("id", u.id)
      )
    );
    for (const r of results) if (!r.error) updated++;
  }

  return NextResponse.json({ success: true, updated });
}
