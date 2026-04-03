"use client";

import { useState } from "react";
import { MediaSearch } from "@/components/media-search";
import { MediaGrid, type MediaItem } from "@/components/media-grid";
import { UploadDropzone } from "@/components/upload-dropzone";

export function CreatorContent({
  creatorSlug,
  creatorId,
  media,
}: {
  creatorSlug: string;
  creatorId: string;
  media: MediaItem[];
}) {
  const [filteredIds, setFilteredIds] = useState<string[] | null>(null);

  const displayMedia =
    filteredIds === null
      ? media
      : filteredIds
          .map((id) => media.find((m) => m.id === id))
          .filter((m): m is MediaItem => m !== undefined);

  return (
    <>
      <MediaSearch
        creatorId={creatorId}
        onResults={(ids) => setFilteredIds(ids)}
        onClear={() => setFilteredIds(null)}
      />

      <UploadDropzone creatorSlug={creatorSlug} creatorId={creatorId} />

      <div className="mt-2">
        {filteredIds !== null && (
          <p className="text-sm text-muted-foreground mb-2">
            Showing {displayMedia.length} of {media.length} results
          </p>
        )}
        <MediaGrid media={displayMedia} />
      </div>
    </>
  );
}
