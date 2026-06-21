// telegram-media/lib/media-analysis/r2/r2-media-cache.ts
// ----------------------------------------------------------------------
// R2 Subclip Cache
// - Hash-based cache key
// - Signed GET URL
// - Corruption verification
// - Lazy TTL cleanup
// ----------------------------------------------------------------------

import {
  envTrue,
  publishAndPresign,
  safeTrunc,
  type R2KeyBuilderArgs,
  type R2LogData,
  type R2LogEvent,
} from "./r2-cache-core";

const MIN_BYTES = 4 * 1024;

export type GetOrCreateSubclipPresignedUrlInput = {
  subclipPath: string;
  filename?: string;
  logTag?: string;
};

export type GetOrCreateSubclipPresignedUrlResult = {
  sha256: string;
  key: string;
  url: string;
  bytes: number;
};

function logR2(
  logTag: string,
  event: string,
  extra?: Record<string, unknown>
): void {
  if (extra !== undefined) {
    console.log(
      `[${logTag}][SUBCLIP][${event}]`,
      extra
    );

    return;
  }

  console.log(`[${logTag}][SUBCLIP][${event}]`);
}

function sanitizeFilename(filename: string): string {
  return String(filename || "subclip.mp4")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildSubclipKey({
  prefix,
  sha256,
  filename,
}: R2KeyBuilderArgs): string {
  const safeFilename = sanitizeFilename(filename);

  return (
    `${prefix}/videos/${sha256}/subclips/` +
    safeFilename
  );
}

function handleR2LogEvent(
  logTag: string,
  event: R2LogEvent,
  extra: R2LogData
): void {
  const key = extra.key;

  switch (event) {
    case "CACHE_BYPASS":
      logR2(
        logTag,
        "CACHE BYPASS (R2_DISABLE_CACHE=1)",
        { key }
      );
      return;

    case "CACHE_HIT_BUT_CORRUPT_REUPLOAD":
      logR2(
        logTag,
        "CACHE HIT BUT CORRUPT → REUPLOAD",
        {
          key,
          remoteBytes: extra.remoteBytes ?? 0,
          localBytes: extra.localBytes ?? 0,
        }
      );
      return;

    case "CACHE_HIT":
      logR2(logTag, "CACHE HIT", {
        key,
        remoteBytes: extra.remoteBytes ?? 0,
        localBytes: extra.localBytes ?? 0,
      });
      return;

    case "TOUCH_OK":
      logR2(logTag, "TOUCH OK", {
        key,
      });
      return;

    case "TOUCH_SKIP":
      logR2(
        logTag,
        "TOUCH SKIP (R2_DISABLE_TOUCH=1)",
        { key }
      );
      return;

    case "UPLOAD_CACHE_BYPASS":
      logR2(logTag, "UPLOAD (CACHE BYPASS)", {
        key,
        sha256: extra.sha256,
        localBytes: extra.localBytes ?? 0,
      });
      return;

    case "CACHE_MISS_UPLOAD":
      logR2(logTag, "CACHE MISS → UPLOAD", {
        key,
        sha256: extra.sha256,
        localBytes: extra.localBytes ?? 0,
      });
      return;

    case "UPLOAD_OK":
      logR2(logTag, "UPLOAD OK", {
        key,
        uploadedBytes: extra.uploadedBytes ?? 0,
        remoteBytes: extra.remoteBytes ?? 0,
      });
      return;

    case "CLEANUP_DELETE":
      logR2(logTag, "CLEANUP DELETE", {
        key,
      });
      return;

    case "CLEANUP_WARN":
      logR2(logTag, "CLEANUP WARN", {
        key,
        err: safeTrunc(extra.err, 300),
      });
      return;

    case "CLEANUP_FAILED":
      logR2(logTag, "CLEANUP WARN", {
        err: safeTrunc(extra.msg, 300),
      });
      return;

    default: {
      const exhaustiveCheck: never = event;
      return exhaustiveCheck;
    }
  }
}

export async function getOrCreateSubclipPresignedUrl({
  subclipPath,
  filename = "subclip.mp4",
  logTag = "R2",
}: GetOrCreateSubclipPresignedUrlInput): Promise<GetOrCreateSubclipPresignedUrlResult> {
  if (!subclipPath || !subclipPath.trim()) {
    throw new Error(
      "getOrCreateSubclipPresignedUrl: subclipPath is required"
    );
  }

  const safeFilename = sanitizeFilename(filename);

  const disableCache = envTrue(
    "R2_DISABLE_CACHE"
  );

  const disableTouch = envTrue(
    "R2_DISABLE_TOUCH"
  );

  const result = await publishAndPresign({
    kind: "subclip",

    filePath: subclipPath,
    filename: safeFilename,
    contentType: "video/mp4",
    minBytes: MIN_BYTES,

    disableCache,
    disableTouch,

    keyBuilder: ({
      prefix,
      sha256,
      filename: keyFilename,
      kind,
    }) =>
      buildSubclipKey({
        prefix,
        sha256,
        filename: keyFilename,
        kind,
      }),

    /*
     * Keep the old cleanup scope:
     *
     * ${prefix}/videos/${sha256}/
     *
     * This includes both the video-level object and its subclips.
     */
    cleanupPrefixBuilder: ({
      prefix,
      sha256,
    }) => `${prefix}/videos/${sha256}/`,

    logTag,

    log: (event, extra) => {
      handleR2LogEvent(
        logTag,
        event,
        extra
      );
    },
  });

  return {
    sha256: result.sha256,
    key: result.key,
    url: result.url,
    bytes: result.bytes,
  };
}