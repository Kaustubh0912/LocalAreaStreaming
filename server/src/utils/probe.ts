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
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -show_entries stream=width,height,codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    
    const lines = stdout.trim().split('\n');
    // ffprobe output depends on streams, usually: [codec, width, height, duration]
    // But format can vary. We'll be safe:
    return {
      duration: parseFloat(lines[lines.length - 1]) || 0,
      codec: lines[0],
      width: parseInt(lines[1], 10),
      height: parseInt(lines[2], 10),
    };
  } catch (e) {
    console.error(`Probe failed for ${filePath}`, e);
    return { duration: 0 };
  }
};
