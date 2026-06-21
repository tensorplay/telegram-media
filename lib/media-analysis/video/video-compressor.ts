// lib/media-analysis/video/video-compressor.ts

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CompressVideoResult = {
  outputPath: string;
  originalSize: number;
  compressedSize: number;
  wasCompressed: boolean;
  processingTime: number;
};

function tail(value: string, maxLength = 3000): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(-maxLength);
}

function runProcess(
  command: string,
  args: string[],
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `${label}: failed to start ${command}: ${error.message}`
        )
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${label}: ${command} exited with code ${String(code)}\n${tail(
            stderr
          )}`
        )
      );
    });
  });
}

/**
 * Return the video duration in seconds using ffprobe.
 */
export async function getVideoDuration(
  videoPath: string
): Promise<number | null> {
  if (!videoPath) {
    return null;
  }

  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.on("error", () => {
      resolve(null);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const duration = Number.parseFloat(stdout.trim());

      if (!Number.isFinite(duration) || duration <= 0) {
        resolve(null);
        return;
      }

      resolve(duration);
    });
  });
}

/**
 * Compress a local video to approximately the requested maximum size.
 *
 * The output is always MP4 with H.264 video, AAC audio and faststart enabled.
 * The caller is responsible for deleting outputPath when wasCompressed=true.
 */
export async function compressVideo(
  inputPath: string,
  targetSizeMB = 9.5
): Promise<CompressVideoResult> {
  if (!inputPath) {
    throw new Error("compressVideo: inputPath is required");
  }

  if (!Number.isFinite(targetSizeMB) || targetSizeMB <= 0) {
    throw new Error(
      "compressVideo: targetSizeMB must be a positive number"
    );
  }

  const startedAt = Date.now();
  const inputStat = await fs.stat(inputPath);
  const originalSize = inputStat.size;
  const originalSizeMB = originalSize / (1024 * 1024);

  console.log("[video-compressor] input", {
    inputPath,
    originalBytes: originalSize,
    originalSizeMB: Number(originalSizeMB.toFixed(2)),
    targetSizeMB,
  });

  if (originalSizeMB <= targetSizeMB) {
    console.log("[video-compressor] compression skipped", {
      reason: "already_under_target",
      originalSizeMB: Number(originalSizeMB.toFixed(2)),
      targetSizeMB,
    });

    return {
      outputPath: inputPath,
      originalSize,
      compressedSize: originalSize,
      wasCompressed: false,
      processingTime: Date.now() - startedAt,
    };
  }

  const duration = await getVideoDuration(inputPath);

  if (!duration) {
    throw new Error(
      "compressVideo: could not determine video duration"
    );
  }

  const outputPath = path.join(
    os.tmpdir(),
    `telegram-media-compressed-${Date.now()}-${crypto
      .randomBytes(6)
      .toString("hex")}.mp4`
  );

  /*
   * Keep a margin below the provider limit.
   *
   * targetSizeMB is already expected to be 9.5 MB, but an additional
   * container/encoding margin avoids producing a file slightly above it.
   */
  const targetSizeBytes =
    targetSizeMB * 1024 * 1024 * 0.95;

  const totalBitrate = Math.floor(
    (targetSizeBytes * 8) / duration
  );

  /*
   * Reserve part of the available bitrate for audio.
   */
  const desiredAudioBitrate = Math.floor(totalBitrate * 0.12);
  const audioBitrate = Math.min(
    128_000,
    Math.max(32_000, desiredAudioBitrate)
  );

  const videoBitrate = Math.max(
    50_000,
    totalBitrate - audioBitrate
  );

  /*
   * Very low bitrates need a smaller resolution to preserve useful visual
   * information for the vision model.
   */
  let maxWidth = 1280;

  if (videoBitrate < 250_000) {
    maxWidth = 640;
  } else if (videoBitrate < 500_000) {
    maxWidth = 854;
  }

  const scaleFilter = `scale='min(${maxWidth},iw)':-2`;

  console.log("[video-compressor] encoding", {
    durationSeconds: Number(duration.toFixed(2)),
    targetSizeMB,
    videoBitrate,
    audioBitrate,
    maxWidth,
    outputPath,
  });

  try {
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",

        "-i",
        inputPath,

        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",

        "-c:v",
        "libx264",

        /*
         * Use bitrate-based encoding rather than CRF because the objective is
         * producing a predictable maximum file size.
         */
        "-b:v",
        String(videoBitrate),
        "-maxrate",
        String(videoBitrate),
        "-bufsize",
        String(videoBitrate * 2),

        "-vf",
        scaleFilter,

        "-preset",
        "fast",

        "-c:a",
        "aac",
        "-b:a",
        String(audioBitrate),

        "-movflags",
        "+faststart",

        "-y",
        outputPath,
      ],
      "compressVideo"
    );

    const outputStat = await fs.stat(outputPath);
    const compressedSize = outputStat.size;
    const compressedSizeMB = compressedSize / (1024 * 1024);
    const processingTime = Date.now() - startedAt;

    if (compressedSize <= 0) {
      throw new Error(
        "compressVideo: ffmpeg produced an empty output file"
      );
    }

    console.log("[video-compressor] completed", {
      originalBytes: originalSize,
      compressedBytes: compressedSize,
      originalSizeMB: Number(originalSizeMB.toFixed(2)),
      compressedSizeMB: Number(compressedSizeMB.toFixed(2)),
      targetSizeMB,
      processingTime,
    });

    if (compressedSizeMB > targetSizeMB) {
      console.warn(
        "[video-compressor] output is still above target",
        {
          compressedSizeMB: Number(compressedSizeMB.toFixed(2)),
          targetSizeMB,
        }
      );
    }

    return {
      outputPath,
      originalSize,
      compressedSize,
      wasCompressed: true,
      processingTime,
    };
  } catch (error) {
    await fs.rm(outputPath, { force: true }).catch(() => {});

    throw error;
  }
}

/**
 * Remove a compressed temporary file.
 */
export async function deleteCompressedVideo(
  filePath: string
): Promise<void> {
  if (!filePath) {
    return;
  }

  try {
    await fs.rm(filePath, { force: true });

    console.log("[video-compressor] temporary file deleted", {
      filePath,
    });
  } catch (error) {
    console.warn(
      "[video-compressor] failed to delete temporary file",
      {
        filePath,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );
  }
}