"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  X,
  Loader2,
  Star,
  Layers,
  FolderInput,
  Trash2,
  Download,
  Sparkles,
  ChevronRight,
  FileText,
  Tag as TagIcon,
  Camera,
  RefreshCw,
} from "lucide-react";
import type { MediaItem } from "@/components/media-grid";
import type { Folder } from "@/components/library-nav";
import {
  CHANNELS,
  FACET_LABELS,
  FACET_ORDER,
  groupContentTags,
  parseTags,
  primaryStatus,
  STATUS_LABELS,
  STATUS_ORDER,
  STATUS_TONE,
  type ChannelValue,
  type StatusValue,
} from "@/lib/facets";
import { LazyMedia } from "@/components/lazy-media";

interface InspectorPanelProps {
  open: boolean;
  onClose: () => void;
  items: (MediaItem & { folder_id?: string | null })[];
  folders: Folder[];
  creatorId: string;
  onMutated: () => void;
}

export function InspectorPanel({
  open,
  onClose,
  items,
  folders,
  creatorId,
  onMutated,
}: InspectorPanelProps) {
  const [busy, setBusy] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");

  // Compute "shared" values across the selection: what all items have in common.
  const summary = useMemo(() => {
    if (items.length === 0) {
      return {
        statuses: new Set<StatusValue>(),
        channels: new Set<ChannelValue>(),
        hero: false,
        variant: false,
        mixedHero: false,
        mixedVariant: false,
        shoot: null as string | null,
        folderId: null as string | null,
        mixedFolder: false,
        allTags: new Map<string, number>(),
      };
    }
    const statuses = new Set<StatusValue>();
    const channels = new Set<ChannelValue>();
    let hero = true;
    let variant = true;
    let anyHero = false;
    let anyVariant = false;
    let shoot: string | null = items[0] ? parseTags(items[0].ai_tags).system.shoot : null;
    let folderId: string | null = items[0]?.folder_id ?? null;
    let mixedFolder = false;
    const allTags = new Map<string, number>();

    for (const item of items) {
      const { content, system } = parseTags(item.ai_tags);
      system.statuses.forEach((s) => statuses.add(s));
      system.channels.forEach((c) => channels.add(c));
      if (system.hero) anyHero = true;
      else hero = false;
      if (system.variant) anyVariant = true;
      else variant = false;
      if (system.shoot !== shoot) shoot = null;
      if ((item.folder_id ?? null) !== folderId) {
        mixedFolder = true;
        folderId = null;
      }
      for (const t of content) allTags.set(t, (allTags.get(t) ?? 0) + 1);
    }

    return {
      statuses,
      channels,
      hero: hero && items.length > 0,
      variant: variant && items.length > 0,
      mixedHero: anyHero && !hero,
      mixedVariant: anyVariant && !variant,
      shoot,
      folderId,
      mixedFolder,
      allTags,
    };
  }, [items]);

  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const primary = items[0];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const mutateTags = useCallback(
    async (opts: {
      add?: string[];
      remove?: string[];
      clearPrefixes?: string[];
    }) => {
      if (ids.length === 0) return;
      setBusy(true);
      try {
        await fetch("/api/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaIds: ids, ...opts }),
        });
        onMutated();
      } finally {
        setBusy(false);
      }
    },
    [ids, onMutated]
  );

  const setStatus = useCallback(
    async (s: StatusValue | null) => {
      await mutateTags({
        clearPrefixes: ["status:"],
        add: s ? [`status:${s}`] : [],
      });
    },
    [mutateTags]
  );

  const toggleChannel = useCallback(
    async (c: ChannelValue) => {
      const has = summary.channels.has(c);
      if (has) {
        await mutateTags({ remove: [`channel:${c}`] });
      } else {
        await mutateTags({ add: [`channel:${c}`] });
      }
    },
    [mutateTags, summary.channels]
  );

  const toggleHero = useCallback(async () => {
    if (summary.hero) {
      await mutateTags({ remove: ["hero"] });
    } else {
      await mutateTags({ add: ["hero"], remove: ["variant"] });
    }
  }, [mutateTags, summary.hero]);

  const markVariant = useCallback(async () => {
    if (summary.variant) {
      await mutateTags({ remove: ["variant"] });
    } else {
      await mutateTags({ add: ["variant"], remove: ["hero"] });
    }
  }, [mutateTags, summary.variant]);

  const moveToFolder = useCallback(
    async (folderId: string | null) => {
      if (ids.length === 0) return;
      setBusy(true);
      try {
        await fetch("/api/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaIds: ids, folderId }),
        });
        onMutated();
        setMoveOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [ids, onMutated]
  );

  const addContentTag = useCallback(async () => {
    const t = tagDraft.trim().toLowerCase();
    if (!t || t.includes(":")) return;
    setTagDraft("");
    await mutateTags({ add: [t] });
  }, [tagDraft, mutateTags]);

  const removeContentTag = useCallback(
    async (tag: string) => {
      await mutateTags({ remove: [tag] });
    },
    [mutateTags]
  );

  const deleteSelection = useCallback(async () => {
    if (!confirm(`Delete ${ids.length} file${ids.length === 1 ? "" : "s"}?`))
      return;
    setBusy(true);
    try {
      await Promise.all(
        ids.map((id) => fetch(`/api/media/${id}`, { method: "DELETE" }))
      );
      onMutated();
      onClose();
    } finally {
      setBusy(false);
    }
  }, [ids, onMutated, onClose]);

  const groupedTags = useMemo(() => {
    const entries = [...summary.allTags.entries()]
      .filter(([, count]) => count === items.length) // only shared across ALL selected
      .map(([tag]) => tag);
    return groupContentTags(entries);
  }, [summary.allTags, items.length]);

  if (!open || items.length === 0) return null;
  const status = primaryStatus(
    [...summary.statuses]
  );
  const multi = items.length > 1;

  return (
    <>
      {/* Backdrop for mobile / small screens */}
      <div
        className="lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside
        className="fixed lg:sticky top-0 right-0 z-40 lg:z-auto h-[100dvh] lg:h-[calc(100dvh-4rem)] w-full sm:w-[26rem] lg:w-[22rem] shrink-0 bg-background border-l shadow-xl lg:shadow-none flex flex-col"
        role="dialog"
        aria-label="Selection inspector"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {multi ? `${items.length} files selected` : primary.filename}
            </p>
            {!multi && primary && (
              <p className="text-[11px] text-muted-foreground">
                {new Date(primary.created_at).toLocaleString()}
              </p>
            )}
            {multi && (
              <p className="text-[11px] text-muted-foreground">
                Edits apply to all selected files
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {!multi && primary && (
            <div className="rounded-lg overflow-hidden bg-neutral-100 dark:bg-neutral-800 aspect-square">
              <LazyMedia
                mediaId={primary.id}
                isVideo={primary.content_type.startsWith("video/")}
                alt={primary.filename}
                className="object-cover w-full h-full"
              />
            </div>
          )}

          {/* Status */}
          <Section icon={<ChevronRight className="h-3 w-3" />} title="Status">
            <div className="flex flex-wrap gap-1.5">
              {STATUS_ORDER.map((s) => {
                const isActive = status === s && !multi;
                const isMixed = multi && summary.statuses.has(s) && summary.statuses.size > 1;
                const tone = STATUS_TONE[s];
                return (
                  <button
                    key={s}
                    disabled={busy}
                    onClick={() => setStatus(s)}
                    className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full border transition-colors ${
                      isActive
                        ? toneBtn(tone, "active")
                        : isMixed
                          ? toneBtn(tone, "mixed")
                          : "bg-card border-border hover:bg-muted"
                    }`}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                );
              })}
              {(summary.statuses.size > 0 || status) && (
                <button
                  disabled={busy}
                  onClick={() => setStatus(null)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full border border-dashed hover:bg-muted"
                >
                  Clear
                </button>
              )}
            </div>
          </Section>

          {/* Hero / Variant */}
          <Section icon={<Star className="h-3 w-3" />} title="Pick">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={summary.hero ? "default" : "outline"}
                onClick={toggleHero}
                disabled={busy}
                className="flex-1"
              >
                <Star
                  className={`h-3.5 w-3.5 mr-1.5 ${
                    summary.hero ? "fill-current" : ""
                  }`}
                />
                Hero
              </Button>
              <Button
                size="sm"
                variant={summary.variant ? "secondary" : "outline"}
                onClick={markVariant}
                disabled={busy}
                className="flex-1"
              >
                Variant
              </Button>
            </div>
            {multi && (summary.mixedHero || summary.mixedVariant) && (
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Selection has mixed pick state. Click to apply to all.
              </p>
            )}
          </Section>

          {/* Channels */}
          <Section icon={<Layers className="h-3 w-3" />} title="Channels">
            <div className="grid grid-cols-2 gap-1.5">
              {CHANNELS.map((c) => {
                const isActive = summary.channels.has(c.value);
                return (
                  <button
                    key={c.value}
                    disabled={busy}
                    onClick={() => toggleChannel(c.value)}
                    className={`inline-flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border transition-colors ${
                      isActive
                        ? "bg-primary/10 border-primary text-primary"
                        : "bg-card border-border hover:bg-muted"
                    }`}
                  >
                    <Layers className="h-3 w-3" />
                    <span className="truncate">{c.label}</span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Campaign / folder */}
          <Section icon={<FolderInput className="h-3 w-3" />} title="Campaign / Folder">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMoveOpen(true)}
              disabled={busy}
              className="w-full justify-start"
            >
              <FolderInput className="h-3.5 w-3.5 mr-2" />
              {summary.mixedFolder
                ? "Mixed folders — move all to..."
                : summary.folderId
                  ? folders.find((f) => f.id === summary.folderId)?.name ?? "Move..."
                  : "Uncategorized — move to..."}
            </Button>
          </Section>

          {/* Shoot */}
          {summary.shoot && (
            <Section icon={<Camera className="h-3 w-3" />} title="Shoot">
              <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs rounded-md border bg-card">
                <span className="truncate">{summary.shoot}</span>
                <button
                  disabled={busy}
                  onClick={() =>
                    mutateTags({ clearPrefixes: ["shoot:"] })
                  }
                  className="text-muted-foreground hover:text-destructive"
                  title="Remove from shoot"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </Section>
          )}

          {/* AI summary */}
          {!multi && primary?.ai_summary && (
            <Section icon={<FileText className="h-3 w-3" />} title="AI summary">
              <p className="text-xs text-muted-foreground leading-relaxed">
                {primary.ai_summary}
              </p>
            </Section>
          )}

          {/* Re-analyze (force re-run Gemini on these files) */}
          <ReanalyzeSection ids={ids} onMutated={onMutated} />


          {/* Content tags (grouped by facet) */}
          <Section icon={<TagIcon className="h-3 w-3" />} title="Content tags">
            {FACET_ORDER.map((facet) => {
              const list = groupedTags[facet];
              if (!list || list.length === 0) return null;
              return (
                <div key={facet} className="mb-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    {FACET_LABELS[facet]}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {list.map((tag) => (
                      <Badge
                        key={tag}
                        variant="secondary"
                        className="gap-1 pr-1"
                      >
                        <span>{tag}</span>
                        <button
                          onClick={() => removeContentTag(tag)}
                          className="hover:text-destructive"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addContentTag();
              }}
              className="flex gap-1.5 mt-2"
            >
              <Input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                placeholder="Add a tag..."
                className="h-8 text-xs"
              />
              <Button
                type="submit"
                size="sm"
                disabled={!tagDraft.trim() || busy}
              >
                Add
              </Button>
            </form>
          </Section>
        </div>

        <footer className="border-t px-4 py-3 space-y-2 shrink-0">
          {!multi && primary && (
            <a
              href={`/api/media/${primary.id}?download=1`}
              download={primary.filename}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs hover:bg-muted transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={deleteSelection}
            disabled={busy}
            className="w-full text-destructive hover:text-destructive"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 mr-2" />
            )}
            Delete {multi ? `${ids.length} files` : "file"}
          </Button>
        </footer>

        {busy && (
          <div className="absolute inset-0 bg-background/40 flex items-center justify-center pointer-events-none">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        )}
      </aside>

      {moveOpen && (
        <MoveToFolderDialog
          folders={folders}
          creatorId={creatorId}
          current={summary.folderId}
          onClose={() => setMoveOpen(false)}
          onSelect={moveToFolder}
          onFoldersChanged={onMutated}
        />
      )}
    </>
  );
}

function ReanalyzeSection({
  ids,
  onMutated,
}: {
  ids: string[];
  onMutated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (ids.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      // Force=true so files that already have an `ai_summary` (including the
      // "Analysis completed" fallback for failed runs) get a fresh Gemini pass.
      const res = await fetch("/api/analyze-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaIds: ids, force: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(
        ids.length === 1
          ? data.successCount === 1
            ? "Re-analyzed."
            : `Re-analyze failed: ${data.results?.[0]?.error ?? "unknown"}`
          : `Re-analyzed: ${data.successCount} ok, ${data.failureCount} failed`
      );
      onMutated();
    } catch (err) {
      setResult(
        `Failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    } finally {
      setBusy(false);
    }
  }, [ids, onMutated]);

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
        Tagging
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={run}
        disabled={busy || ids.length === 0}
        className="w-full justify-start"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
        )}
        Re-analyze {ids.length > 1 ? `${ids.length} files` : "this file"}
      </Button>
      {result && (
        <p className="text-[11px] text-muted-foreground mt-1.5">{result}</p>
      )}
    </div>
  );
}

function Section({
  title,
  children,
  icon: _icon,
}: {
  title: string;
  children: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
        {title}
      </p>
      {children}
    </div>
  );
}

function toneBtn(
  tone: "green" | "blue" | "amber" | "red" | "neutral",
  kind: "active" | "mixed"
) {
  if (kind === "mixed") {
    return "bg-muted border-dashed";
  }
  switch (tone) {
    case "green":
      return "bg-emerald-500 border-emerald-500 text-white";
    case "blue":
      return "bg-sky-500 border-sky-500 text-white";
    case "amber":
      return "bg-amber-500 border-amber-500 text-white";
    case "red":
      return "bg-rose-500 border-rose-500 text-white";
    default:
      return "bg-neutral-700 border-neutral-700 text-white";
  }
}

// ---------------------------------------------------------------------------
// Small dialog for picking a folder (replaces the old MoveDialog usage).
// ---------------------------------------------------------------------------

function MoveToFolderDialog({
  folders,
  creatorId,
  current,
  onClose,
  onSelect,
  onFoldersChanged,
}: {
  folders: Folder[];
  creatorId: string;
  current: string | null;
  onClose: () => void;
  onSelect: (id: string | null) => Promise<void>;
  onFoldersChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, creatorId }),
    });
    if (res.ok) {
      const { folder } = await res.json();
      await onSelect(folder.id);
      setNewName("");
      setCreating(false);
      onFoldersChanged();
    }
  }

  const sorted = [...folders].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[min(90vw,24rem)] rounded-lg border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold">Move to folder</p>
          <button onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-64 overflow-y-auto space-y-0.5">
          <button
            onClick={() => onSelect(null)}
            className={`flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md transition-colors ${
              current === null ? "bg-primary/10 text-primary" : "hover:bg-muted"
            }`}
          >
            Uncategorized
          </button>
          {sorted.map((f) => (
            <button
              key={f.id}
              onClick={() => onSelect(f.id)}
              className={`flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md transition-colors ${
                current === f.id
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted"
              }`}
              style={{ paddingLeft: `${8 + (f.parent_id ? 16 : 0)}px` }}
            >
              {f.name}
            </button>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t">
          {creating ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCreate();
              }}
              className="flex gap-2"
            >
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New folder name"
                autoFocus
                className="h-8 text-xs"
              />
              <Button size="sm" type="submit" disabled={!newName.trim()}>
                Create
              </Button>
            </form>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              <Sparkles className="h-3 w-3" />
              New folder...
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
