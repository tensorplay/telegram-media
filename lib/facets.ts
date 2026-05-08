/**
 * Facet conventions layered on top of the existing `ai_tags` array.
 *
 * We reserve prefixed tags for system-level metadata so we can add lifecycle,
 * channel assignment, shoot membership, etc. without a schema change. Any tag
 * matching one of the reserved prefixes is treated as a "system" tag and
 * rendered separately from the descriptive content tags Gemini produces.
 */

export type StatusValue =
  | "raw"
  | "approved-creator"
  | "approved-brand"
  | "scheduled"
  | "posted"
  | "rejected";

export type ChannelValue =
  | "ig-grid"
  | "ig-story"
  | "reel"
  | "tiktok"
  | "yt-thumb"
  | "twitter";

export const STATUS_ORDER: StatusValue[] = [
  "raw",
  "approved-creator",
  "approved-brand",
  "scheduled",
  "posted",
  "rejected",
];

export const STATUS_LABELS: Record<StatusValue, string> = {
  raw: "Raw",
  "approved-creator": "Creator OK",
  "approved-brand": "Brand OK",
  scheduled: "Scheduled",
  posted: "Posted",
  rejected: "Rejected",
};

export const STATUS_TONE: Record<
  StatusValue,
  "neutral" | "amber" | "blue" | "green" | "red"
> = {
  raw: "neutral",
  "approved-creator": "amber",
  "approved-brand": "amber",
  scheduled: "blue",
  posted: "green",
  rejected: "red",
};

export const CHANNELS: { value: ChannelValue; label: string; aspect: "1:1" | "4:5" | "9:16" | "16:9" }[] = [
  { value: "ig-grid", label: "IG Grid", aspect: "4:5" },
  { value: "ig-story", label: "IG Stories", aspect: "9:16" },
  { value: "reel", label: "Reels", aspect: "9:16" },
  { value: "tiktok", label: "TikTok", aspect: "9:16" },
  { value: "yt-thumb", label: "YouTube Thumbs", aspect: "16:9" },
  { value: "twitter", label: "Twitter / X", aspect: "1:1" },
];

export const RESERVED_PREFIXES = [
  "shoot:",
  "status:",
  "channel:",
  "brand:",
  "outfit:",
  "location:",
];

export const RESERVED_SINGLETONS = new Set(["hero", "variant"]);

/** Tag keyword dictionary used to group unprefixed content tags into facets. */
const FACET_KEYWORDS: { facet: ContentFacet; patterns: RegExp[] }[] = [
  {
    facet: "outfit",
    patterns: [
      /\b(dress|shirt|tee|t-shirt|top|blouse|sweater|hoodie|jacket|coat|suit|tuxedo|pants|trousers|jeans|shorts|skirt|leggings|athleisure|activewear|gym wear|lingerie|bikini|swimsuit|swimwear|gown|romper|jumpsuit|outfit|clothing|uniform|robe|cardigan|vest|blazer|scarf|hat|cap|beanie|boots|heels|sneakers|sandals|shoes|jewelry|necklace|earrings|bracelet|ring|watch|sunglasses|glasses)\b/i,
    ],
  },
  {
    facet: "location",
    patterns: [
      /\b(bedroom|bathroom|kitchen|living room|office|studio|gym|cafe|coffee shop|restaurant|bar|pool|beach|ocean|forest|park|garden|street|city|rooftop|balcony|hotel|bed|couch|car|plane|airport|store|mall|stage|backstage|outdoor|indoor|daytime|nighttime|sunset|sunrise|home|outdoors|indoors)\b/i,
    ],
  },
  {
    facet: "mood",
    patterns: [
      /\b(smiling|laughing|serious|sultry|sexy|confident|relaxed|happy|sad|thoughtful|playful|flirty|moody|dramatic|candid|posed|natural|edgy|soft|warm|cold|cozy|intimate|bold|cheerful|melancholy|peaceful|energetic)\b/i,
    ],
  },
  {
    facet: "subject",
    patterns: [
      /\b(portrait|headshot|selfie|mirror selfie|full body|close-up|closeup|medium shot|wide shot|from behind|side profile|three-quarter|back view|hands|feet|face|makeup|hair|curly hair|straight hair|wavy hair|blonde|brunette|redhead|red hair|brown hair|black hair|freckles|bangs|ponytail|bun|updo|woman|man|person|group|couple|friends)\b/i,
    ],
  },
];

export type ContentFacet = "outfit" | "location" | "mood" | "subject" | "other";

export const FACET_ORDER: ContentFacet[] = [
  "outfit",
  "location",
  "mood",
  "subject",
  "other",
];

export const FACET_LABELS: Record<ContentFacet, string> = {
  outfit: "Outfit",
  location: "Scene",
  mood: "Mood",
  subject: "Subject",
  other: "Other",
};

export interface ParsedTags {
  /** Descriptive tags emitted by the AI that don't have a reserved prefix. */
  content: string[];
  /** Reserved system tags, grouped by facet. */
  system: {
    shoot: string | null;
    statuses: StatusValue[];
    channels: ChannelValue[];
    brand: string | null;
    outfit: string | null;
    location: string | null;
    hero: boolean;
    variant: boolean;
    /** Any other reserved tag we don't know about (forward-compat). */
    other: string[];
  };
}

export function parseTags(raw: string[] | null | undefined): ParsedTags {
  const system: ParsedTags["system"] = {
    shoot: null,
    statuses: [],
    channels: [],
    brand: null,
    outfit: null,
    location: null,
    hero: false,
    variant: false,
    other: [],
  };
  const content: string[] = [];

  if (!raw) return { content, system };

  for (const tag of raw) {
    if (typeof tag !== "string") continue;
    const t = tag.trim().toLowerCase();
    if (!t) continue;

    if (t === "hero") {
      system.hero = true;
      continue;
    }
    if (t === "variant") {
      system.variant = true;
      continue;
    }
    if (t.startsWith("shoot:")) {
      system.shoot = t.slice(6);
      continue;
    }
    if (t.startsWith("status:")) {
      const v = t.slice(7) as StatusValue;
      if (STATUS_ORDER.includes(v)) system.statuses.push(v);
      else system.other.push(t);
      continue;
    }
    if (t.startsWith("channel:")) {
      // channel:<name> or channel:<name>:<ordering-key>
      const rest = t.slice(8);
      const name = rest.split(":")[0] as ChannelValue;
      if (CHANNELS.some((c) => c.value === name)) {
        if (!system.channels.includes(name)) system.channels.push(name);
      } else {
        system.other.push(t);
      }
      continue;
    }
    if (t.startsWith("brand:")) {
      system.brand = t.slice(6);
      continue;
    }
    if (t.startsWith("outfit:")) {
      system.outfit = t.slice(7);
      continue;
    }
    if (t.startsWith("location:")) {
      system.location = t.slice(9);
      continue;
    }
    content.push(t);
  }

  return { content, system };
}

/** Which tags are "system" vs "content" for a raw array. */
export function isReservedTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  if (RESERVED_SINGLETONS.has(t)) return true;
  return RESERVED_PREFIXES.some((p) => t.startsWith(p));
}

/** Pick the highest-priority status from a file's tags. Posted > scheduled > approved > raw > rejected. */
export function primaryStatus(statuses: StatusValue[]): StatusValue | null {
  if (statuses.length === 0) return null;
  // Reverse of STATUS_ORDER so "posted" wins over "approved" etc.
  const priority: StatusValue[] = [
    "posted",
    "scheduled",
    "approved-brand",
    "approved-creator",
    "rejected",
    "raw",
  ];
  for (const p of priority) {
    if (statuses.includes(p)) return p;
  }
  return statuses[0];
}

/** Group a list of content tags into facets using the keyword dictionary. */
export function groupContentTags(
  content: string[]
): Record<ContentFacet, string[]> {
  const out: Record<ContentFacet, string[]> = {
    outfit: [],
    location: [],
    mood: [],
    subject: [],
    other: [],
  };
  for (const t of content) {
    let placed = false;
    for (const { facet, patterns } of FACET_KEYWORDS) {
      if (patterns.some((re) => re.test(t))) {
        out[facet].push(t);
        placed = true;
        break;
      }
    }
    if (!placed) out.other.push(t);
  }
  return out;
}

/**
 * Produce a short list of "what makes this tile distinctive" tags for the
 * grid. Prefers outfit/location/mood over generic subject tags, and skips
 * tags that appear on more than half the library (since those convey no
 * signal for this creator).
 */
export function distinctiveTags(
  content: string[],
  globalCounts: Map<string, number>,
  totalFiles: number,
  limit = 3
): string[] {
  const threshold = Math.max(2, Math.floor(totalFiles * 0.5));
  const scored = content
    .filter((t) => (globalCounts.get(t) ?? 0) <= threshold)
    .map((t) => {
      let score = 0;
      for (const { patterns } of FACET_KEYWORDS.slice(0, 3)) {
        // outfit/location/mood win over subject
        if (patterns.some((re) => re.test(t))) {
          score += 2;
          break;
        }
      }
      // Rarity bonus — rarer tags are more informative.
      const freq = globalCounts.get(t) ?? 0;
      score += Math.max(0, 3 - Math.log10(freq + 1));
      return { t, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.t);
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
}
