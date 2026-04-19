"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, Minus, Tag, X } from "lucide-react";

export type TagFilterState = "neutral" | "include" | "exclude";

export function TagFilter({
  allTags,
  includeTags,
  excludeTags,
  onCycle,
  onRemove,
  onClear,
}: {
  allTags: { tag: string; count: number }[];
  includeTags: Set<string>;
  excludeTags: Set<string>;
  onCycle: (tag: string) => void;
  onRemove: (tag: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) {
        return;
      }
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? allTags.filter((t) => t.tag.toLowerCase().includes(q))
      : allTags;
    return list.slice(0, 200);
  }, [allTags, query]);

  const totalActive = includeTags.size + excludeTags.size;
  const hasAny = allTags.length > 0;

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Button
            ref={triggerRef}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setOpen((v) => !v)}
            disabled={!hasAny}
          >
            <Tag className="h-3.5 w-3.5 mr-1.5" />
            Filter by tag
            {totalActive > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium">
                {totalActive}
              </span>
            )}
          </Button>
          {open && (
            <div
              ref={panelRef}
              className="absolute left-0 top-full mt-1.5 z-20 w-72 rounded-md border bg-popover text-popover-foreground shadow-md"
            >
              <div className="p-2 border-b">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tags..."
                  autoFocus
                  className="h-8"
                />
                <p className="text-[10px] text-muted-foreground mt-1.5 px-0.5">
                  Click once to include, again to exclude, again to clear.
                </p>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {filtered.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                    No tags found
                  </div>
                ) : (
                  filtered.map(({ tag, count }) => {
                    const included = includeTags.has(tag);
                    const excluded = excludeTags.has(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => onCycle(tag)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left hover:bg-muted transition-colors"
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            included
                              ? "bg-primary border-primary text-primary-foreground"
                              : excluded
                                ? "bg-destructive border-destructive text-destructive-foreground"
                                : "border-input"
                          }`}
                        >
                          {included && <Check className="h-3 w-3" />}
                          {excluded && <Minus className="h-3 w-3" />}
                        </span>
                        <span
                          className={`flex-1 truncate ${
                            excluded ? "line-through text-muted-foreground" : ""
                          }`}
                        >
                          {tag}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {count}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {Array.from(includeTags)
          .sort()
          .map((tag) => (
            <ActiveChip
              key={`inc-${tag}`}
              label={tag}
              variant="include"
              onRemove={() => onRemove(tag)}
            />
          ))}
        {Array.from(excludeTags)
          .sort()
          .map((tag) => (
            <ActiveChip
              key={`exc-${tag}`}
              label={tag}
              variant="exclude"
              onRemove={() => onRemove(tag)}
            />
          ))}

        {totalActive > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-1"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}

function ActiveChip({
  label,
  variant,
  onRemove,
}: {
  label: string;
  variant: "include" | "exclude";
  onRemove: () => void;
}) {
  const cls =
    variant === "include"
      ? "bg-primary/10 text-primary border-primary/30"
      : "bg-destructive/10 text-destructive border-destructive/30";
  return (
    <span
      className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs rounded-full border ${cls}`}
    >
      {variant === "exclude" && <Minus className="h-3 w-3 shrink-0" />}
      <span
        className={`max-w-[12rem] truncate ${
          variant === "exclude" ? "line-through" : ""
        }`}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex items-center justify-center h-4 w-4 rounded-full hover:bg-background/60"
        aria-label={`Remove ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
