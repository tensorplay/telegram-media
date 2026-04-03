"use client";

import { useState } from "react";
import { Search, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface SearchResult {
  id: string;
  similarity: number;
}

export function MediaSearch({
  creatorId,
  onResults,
  onClear,
}: {
  creatorId: string;
  onResults: (ids: string[]) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasResults, setHasResults] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, creatorId }),
      });

      if (!res.ok) return;

      const { results } = (await res.json()) as { results: SearchResult[] };
      const ids = results
        .filter((r) => r.similarity > 0.3)
        .map((r) => r.id);
      onResults(ids);
      setHasResults(true);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setQuery("");
    setHasResults(false);
    onClear();
  }

  return (
    <form onSubmit={handleSearch} className="flex gap-2 mb-4">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search media... e.g. "outdoor portrait" or "blue dress"'
          className="pl-9 pr-4"
        />
      </div>
      <Button
        type="submit"
        disabled={loading || !query.trim()}
        className="touch-manipulation shrink-0"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          "Search"
        )}
      </Button>
      {hasResults && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleClear}
          className="touch-manipulation shrink-0"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </form>
  );
}
