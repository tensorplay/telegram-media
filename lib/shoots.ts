/**
 * Pure client-side clustering that turns a flat media list into "shoots" —
 * the agency-content-ops atomic unit: everything from one session/outfit/day.
 *
 * We cluster on two signals that live in data we already have:
 *   1. Upload timestamp (`created_at`) — adjacent uploads tend to be the same
 *      batch. A gap > ~6 hours starts a new shoot.
 *   2. Tag overlap — if the same creator uploads two different batches within
 *      the 6-hour window, a drop in tag Jaccard similarity forces a split.
 *
 * Named lazily from the most distinctive shared tags across members.
 */

import { parseTags } from "@/lib/facets";

export interface ShootInputItem {
  id: string;
  created_at: string;
  ai_tags?: string[] | null;
  filename?: string;
}

export interface Shoot<T extends ShootInputItem = ShootInputItem> {
  /** Deterministic id derived from member ids — stable across renders. */
  id: string;
  /** Pretty display name derived from distinctive tags or date. */
  name: string;
  /** Short slug suitable for writing as `shoot:<slug>` tag. */
  slug: string;
  /** ISO timestamp of earliest member. */
  startsAt: string;
  /** ISO timestamp of latest member. */
  endsAt: string;
  /** Member files, sorted oldest-first. */
  items: T[];
  /** Top tags shared across members (descending frequency within shoot). */
  topTags: string[];
  /** Whether this shoot was persisted via a `shoot:<slug>` tag on all items. */
  promoted: boolean;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TAG_JACCARD_SPLIT = 0.2;

/**
 * Return all shoots for a creator's media. If any items carry a `shoot:<slug>`
 * tag, those slugs become authoritative clusters — we don't overwrite user
 * intent. Remaining items fall through to time + tag-overlap clustering.
 */
export function clusterShoots<T extends ShootInputItem>(items: T[]): Shoot<T>[] {
  if (items.length === 0) return [];

  const promotedBuckets = new Map<string, T[]>();
  const unassigned: T[] = [];

  for (const item of items) {
    const { system } = parseTags(item.ai_tags ?? null);
    if (system.shoot) {
      const key = system.shoot;
      const list = promotedBuckets.get(key) ?? [];
      list.push(item);
      promotedBuckets.set(key, list);
    } else {
      unassigned.push(item);
    }
  }

  const shoots: Shoot<T>[] = [];

  for (const [slug, members] of promotedBuckets.entries()) {
    shoots.push(buildShoot(members, { slug, promoted: true }));
  }

  // Time-sort the unassigned ones. `created_at` is ISO so string sort works.
  unassigned.sort((a, b) => a.created_at.localeCompare(b.created_at));

  let current: T[] = [];
  let currentTagSet: Set<string> | null = null;

  const flush = () => {
    if (current.length === 0) return;
    shoots.push(buildShoot(current, { promoted: false }));
    current = [];
    currentTagSet = null;
  };

  for (const item of unassigned) {
    if (current.length === 0) {
      current.push(item);
      currentTagSet = tagSet(item);
      continue;
    }

    const prev = current[current.length - 1];
    const gap = timeGapMs(prev.created_at, item.created_at);

    if (gap > SIX_HOURS_MS) {
      flush();
      current.push(item);
      currentTagSet = tagSet(item);
      continue;
    }

    // Still within the time window — check tag overlap. If the incoming
    // item has tags but shares very few with the accumulated set, call it
    // a different shoot.
    const incoming = tagSet(item);
    if (currentTagSet && incoming.size > 0 && currentTagSet.size > 0) {
      const sim = jaccard(currentTagSet, incoming);
      if (sim < TAG_JACCARD_SPLIT) {
        flush();
        current.push(item);
        currentTagSet = incoming;
        continue;
      }
    }

    current.push(item);
    if (currentTagSet) {
      for (const t of incoming) currentTagSet.add(t);
    } else {
      currentTagSet = incoming;
    }
  }
  flush();

  // Newest shoots first in the UI.
  shoots.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return shoots;
}

function tagSet(item: ShootInputItem): Set<string> {
  const out = new Set<string>();
  const tags = item.ai_tags ?? [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const k = t.trim().toLowerCase();
    if (!k) continue;
    // System tags are not meaningful for shoot similarity.
    if (k.includes(":") || k === "hero" || k === "variant") continue;
    out.add(k);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function timeGapMs(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime());
}

function buildShoot<T extends ShootInputItem>(
  members: T[],
  opts: { slug?: string; promoted: boolean }
): Shoot<T> {
  members.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const startsAt = members[0].created_at;
  const endsAt = members[members.length - 1].created_at;

  // Tag frequency inside the shoot.
  const freq = new Map<string, number>();
  for (const m of members) {
    const tags = tagSet(m);
    for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const topTags = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([t]) => t);

  const { name, slug } = namedFrom(topTags, startsAt, opts.slug);
  const id = opts.slug
    ? `shoot:${opts.slug}`
    : `auto:${hashIds(members.map((m) => m.id))}`;

  return {
    id,
    name,
    slug,
    startsAt,
    endsAt,
    items: members,
    topTags,
    promoted: opts.promoted,
  };
}

function namedFrom(
  topTags: string[],
  startsAt: string,
  explicitSlug?: string
): { name: string; slug: string } {
  const date = new Date(startsAt);
  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  // Prefer a 2-tag combination when both exist. The keyword dictionary in
  // facets.ts already biases outfit/location above subject, so topTags
  // usually leads with those.
  const signature = topTags.slice(0, 2).join(" · ");
  const displayName = signature ? `${titleCase(signature)} — ${dateStr}` : `Shoot — ${dateStr}`;

  const slugBase = explicitSlug ?? (topTags.slice(0, 2).join("-") || "shoot");
  const slug = slugify(slugBase);

  return { name: displayName, slug };
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s·-]/g, "")
    .replace(/·/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}

function hashIds(ids: string[]): string {
  // Deterministic short hash — we just need stability for React keys.
  let h = 2166136261;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16);
}

/**
 * Detect near-duplicate bursts *within* a shoot by pairing items whose
 * filenames are sequential (IMG_3613 / IMG_3614 / IMG_3615…) and whose
 * timestamps fall within ~2 minutes of each other. This is a cheap proxy for
 * embedding similarity that works without exposing embeddings client-side.
 */
export function detectBursts<T extends ShootInputItem>(
  shoot: Shoot<T>,
  minBurst = 3
): T[][] {
  if (shoot.items.length < minBurst) return [];
  const bursts: T[][] = [];
  let run: T[] = [];

  const extractNumber = (name?: string) => {
    if (!name) return null;
    const m = name.match(/(\d+)(?=\.[a-z0-9]+$)/i);
    return m ? parseInt(m[1], 10) : null;
  };

  for (const item of shoot.items) {
    const prev = run[run.length - 1];
    if (!prev) {
      run = [item];
      continue;
    }
    const prevNum = extractNumber(prev.filename);
    const curNum = extractNumber(item.filename);
    const gap = timeGapMs(prev.created_at, item.created_at);
    const sequential =
      prevNum !== null && curNum !== null && Math.abs(curNum - prevNum) <= 3;
    const proximate = gap < 2 * 60 * 1000;

    if (sequential && proximate) {
      run.push(item);
    } else {
      if (run.length >= minBurst) bursts.push(run);
      run = [item];
    }
  }
  if (run.length >= minBurst) bursts.push(run);
  return bursts;
}
