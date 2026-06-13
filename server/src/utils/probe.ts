import { execFile } from "child_process";
import util from "util";

const execFilePromise = util.promisify(execFile);

export interface MediaInfo {
  duration: number;
  width?: number;
  height?: number;
  codec?: string;
  audioCodec?: string;
  subtitleCodecs?: string[];
  hasSubtitles?: boolean;
}

interface FfprobeStream {
  codec_type?: "video" | "audio" | "subtitle";
  codec_name?: string;
  width?: number;
  height?: number;
}

export const probeMedia = async (filePath: string): Promise<MediaInfo> => {
  try {
    const [durationResult, streamsResult] = await Promise.all([
      execFilePromise(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          filePath,
        ],
        { windowsHide: true },
      ),
      execFilePromise(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,codec_name,width,height",
          "-of",
          "json",
          filePath,
        ],
        { windowsHide: true, maxBuffer: 1024 * 1024 * 2 },
      ),
    ]);

    const duration = parseFloat(durationResult.stdout.trim()) || 0;
    const parsed = JSON.parse(streamsResult.stdout || '{"streams":[]}') as {
      streams?: FfprobeStream[];
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const subtitleCodecs = streams
      .filter((stream) => stream.codec_type === "subtitle" && stream.codec_name)
      .map((stream) => stream.codec_name as string);

    return {
      duration,
      width: video?.width,
      height: video?.height,
      codec: video?.codec_name,
      audioCodec: audio?.codec_name,
      subtitleCodecs,
      hasSubtitles: subtitleCodecs.length > 0,
    };
  } catch (e) {
    console.error(`Probe failed for ${filePath}`, e);
    return { duration: 0, hasSubtitles: false, subtitleCodecs: [] };
  }
};
