// lib/media-analysis/video/prepare-video-for-analysis.ts

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getOrCreateSubclipPresignedUrl } from "../r2/r2-media-cache";
import {
  compressVideo,
  deleteCompressedVideo,
} from "./video-compressor";

const DEFAULT_MAX_VIDEO_SIZE_MB = 10;
const DEFAULT_TARGET_VIDEO_SIZE_MB = 9.5;

export type PrepareVideoForAnalysisInput = {
  mediaBytes: Buffer;
  mimeType: string;

  /**
   * Existing URL for the original source.
   *
   * When the video is already under maxSizeMB, this URL can be reused without
   * uploading another R2 object.
   */
  originalMediaUrl?: string | null;

  filename?: string;
  maxSizeMB?: number;
  targetSizeMB?: number;
  logTag?: string;
};

export type PreparedVideoForAnalysis = {
  mediaBytes: Buffer;
  mediaUrl: string;

  originalBytes: number;
  processedBytes: number;

  wasCompressed: boolean;
  usedOriginalMediaUrl: boolean;

  r2Key: string | null;
  sha256: string | null;

  cleanup: () => Promise<void>;
};

function getVideoExtension(mimeType: string): string {
  const normalizedMimeType = String(mimeType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();

  if (normalizedMimeType === "video/webm") {
    return ".webm";
  }

  if (
    normalizedMimeType === "video/quicktime" ||
    normalizedMimeType === "video/mov"
  ) {
    return ".mov";
  }

  if (normalizedMimeType === "video/x-matroska") {
    return ".mkv";
  }

  return ".mp4";
}

function sanitizeFilename(filename: string): string {
  const cleaned = String(filename || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");

  return cleaned || "video.mp4";
}

function buildOriginalTempPath(
  mimeType: string,
  filename?: string
): string {
  const extension = getVideoExtension(mimeType);

  const requestedFilename = filename
    ? sanitizeFilename(filename)
    : `source${extension}`;

  const finalFilename = path.extname(requestedFilename)
    ? requestedFilename
    : `${requestedFilename}${extension}`;

  return path.join(
    os.tmpdir(),
    `telegram-media-source-${Date.now()}-${crypto
      .randomBytes(6)
      .toString("hex")}-${finalFilename}`
  );
}

async function removeFile(filePath: string | null): Promise<void> {
  if (!filePath) {
    return;
  }

  await fs.rm(filePath, { force: true }).catch(() => {});
}

export async function prepareVideoForAnalysis(
  input: PrepareVideoForAnalysisInput
): Promise<PreparedVideoForAnalysis> {
  const {
    mediaBytes,
    mimeType,
    originalMediaUrl = null,
    filename = "video.mp4",
    maxSizeMB = DEFAULT_MAX_VIDEO_SIZE_MB,
    targetSizeMB = DEFAULT_TARGET_VIDEO_SIZE_MB,
    logTag = "VISION_VIDEO",
  } = input;

  if (!Buffer.isBuffer(mediaBytes)) {
    throw new Error(
      "prepareVideoForAnalysis: mediaBytes must be a Buffer"
    );
  }

  if (mediaBytes.length === 0) {
    throw new Error(
      "prepareVideoForAnalysis: mediaBytes cannot be empty"
    );
  }

  if (!String(mimeType || "").startsWith("video/")) {
    throw new Error(
      `prepareVideoForAnalysis: unsupported mimeType "${mimeType}"`
    );
  }

  if (!Number.isFinite(maxSizeMB) || maxSizeMB <= 0) {
    throw new Error(
      "prepareVideoForAnalysis: maxSizeMB must be positive"
    );
  }

  if (!Number.isFinite(targetSizeMB) || targetSizeMB <= 0) {
    throw new Error(
      "prepareVideoForAnalysis: targetSizeMB must be positive"
    );
  }

  if (targetSizeMB >= maxSizeMB) {
    throw new Error(
      "prepareVideoForAnalysis: targetSizeMB must be lower than maxSizeMB"
    );
  }

  const originalBytes = mediaBytes.length;
  const originalSizeMB = originalBytes / (1024 * 1024);

  console.log("[prepare-video-for-analysis] input", {
    mimeType,
    originalBytes,
    originalSizeMB: Number(originalSizeMB.toFixed(2)),
    maxSizeMB,
    targetSizeMB,
    hasOriginalMediaUrl: Boolean(originalMediaUrl),
  });

  /*
   * Reuse the original URL when the source is already small enough.
   */
  if (
    originalSizeMB <= maxSizeMB &&
    typeof originalMediaUrl === "string" &&
    originalMediaUrl.trim()
  ) {
    console.log(
      "[prepare-video-for-analysis] using original media URL",
      {
        originalBytes,
        originalSizeMB: Number(originalSizeMB.toFixed(2)),
      }
    );

    return {
      mediaBytes,
      mediaUrl: originalMediaUrl.trim(),
      originalBytes,
      processedBytes: originalBytes,
      wasCompressed: false,
      usedOriginalMediaUrl: true,
      r2Key: null,
      sha256: null,
      cleanup: async () => {},
    };
  }

  const originalTempPath = buildOriginalTempPath(
    mimeType,
    filename
  );

  let compressedTempPath: string | null = null;
  let cleanupCompleted = false;

  const cleanup = async (): Promise<void> => {
    if (cleanupCompleted) {
      return;
    }

    cleanupCompleted = true;

    const paths = new Set<string>();

    paths.add(originalTempPath);

    if (compressedTempPath) {
      paths.add(compressedTempPath);
    }

    for (const filePath of paths) {
      if (filePath === compressedTempPath) {
        await deleteCompressedVideo(filePath);
      } else {
        await removeFile(filePath);
      }
    }

    console.log(
      "[prepare-video-for-analysis] cleanup completed",
      {
        files: Array.from(paths),
      }
    );
  };

  try {
    await fs.writeFile(originalTempPath, mediaBytes);

    const writtenStat = await fs.stat(originalTempPath);

    if (writtenStat.size !== originalBytes) {
      throw new Error(
        `prepareVideoForAnalysis: temporary source size mismatch ` +
          `(expected=${originalBytes}, actual=${writtenStat.size})`
      );
    }

    console.log(
      "[prepare-video-for-analysis] source written",
      {
        originalTempPath,
        bytes: writtenStat.size,
      }
    );

    const compressionResult = await compressVideo(
      originalTempPath,
      targetSizeMB
    );

    const processedPath = compressionResult.outputPath;

    if (compressionResult.wasCompressed) {
      compressedTempPath = processedPath;
    }

    const processedStat = await fs.stat(processedPath);

    if (processedStat.size <= 0) {
      throw new Error(
        "prepareVideoForAnalysis: processed video is empty"
      );
    }

    const processedMediaBytes = await fs.readFile(processedPath);

    console.log(
      "[prepare-video-for-analysis] publishing processed video",
      {
        processedPath,
        processedBytes: processedStat.size,
        processedSizeMB: Number(
          (processedStat.size / (1024 * 1024)).toFixed(2)
        ),
        wasCompressed: compressionResult.wasCompressed,
      }
    );

    const published =
      await getOrCreateSubclipPresignedUrl({
        subclipPath: processedPath,
        filename: "video.mp4",
        logTag,
      });

    if (!published?.url) {
      throw new Error(
        "prepareVideoForAnalysis: R2 publisher returned no URL"
      );
    }

    console.log(
      "[prepare-video-for-analysis] ready",
      {
        originalBytes,
        processedBytes: processedStat.size,
        wasCompressed: compressionResult.wasCompressed,
        r2Key: published.key,
        sha256: published.sha256,
        hasMediaUrl: true,
        mediaUrlHasQuery: published.url.includes("?"),
      }
    );

    return {
      mediaBytes: processedMediaBytes,
      mediaUrl: published.url,
      originalBytes,
      processedBytes: processedStat.size,
      wasCompressed: compressionResult.wasCompressed,
      usedOriginalMediaUrl: false,
      r2Key: published.key ?? null,
      sha256: published.sha256 ?? null,
      cleanup,
    };  
  } catch (error) {
    await cleanup();
    throw error;
  }
}