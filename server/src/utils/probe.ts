import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export interface MediaInfo {
  duration: number;
  width?: number;
  height?: number;
  codec?: string;
}

export const probeMedia = async (filePath: string): Promise<MediaInfo> => {
  try {
    // Get duration
    const durRes = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
    const duration = parseFloat(durRes.stdout.trim()) || 0;

    // Get video codec
    const codecRes = await execPromise(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
    const codec = codecRes.stdout.trim().split('\n')[0];

    return {
      duration,
      codec
    };
  } catch (e) {
    console.error(`Probe failed for ${filePath}`, e);
    return { duration: 0 };
  }
};
