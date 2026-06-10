/**
 * Cleans up movie filenames to produce professional titles.
 */
export const parseMovieTitle = (filename: string): string => {
  // 1. Remove extension
  let title = filename.replace(/\.[^/.]+$/, "");

  // 2. Initial cleanup: Replace dots, underscores, dashes, and brackets with spaces immediately
  // This makes it easier to match whole "words"
  title = title.replace(/[\._\-\[\]\(\)]/g, " ");

  // 3. Define "Junk" patterns to strip (Case Insensitive)
  const junkPatterns = [
    /\b\d{4}\b/g, // Years (standalone 4 digits)
    /\b(1080p|720p|2160p|4k|5k|8k|hd|sd|imax|hdr|hdr10|dovi|dv)\b/gi, // Resolution & HDR/DV
    /\b(bluray|brrip|bdrip|web-dl|webrip|hdtv|dvdrip|dvd|cam|ts|hc)\b/gi, // Source
    /\b(x264|x265|h264|hevc|10bit|avc|vc1)\b/gi, // Codec
    /\b(dts|aac|ac3|truehd|dts-hd|atmos)\d?(\s?1)?\b/gi, // Audio Codecs + Channel remainder (handles AAC5 1, DTS6 1)
    /\b([57]\s?1|ch)\b/gi, // Channels (standalone 5 1, 7 1)
    /\b(proper|repack|limited|unrated|extended|remastered|multi|subs?|dual)\b/gi, // Common tags
    /\b(directors\s?cut|theatrical|collector|anniversary)\b/gi, // Editions
    /\b(yts|yify|rarbg|ettv|shaanig|psigig|tgx|vppv|ion10|bz|psig)\b/gi, // Release groups & suffixes
    /\b(mx|es|en|fr|jp|ko|hi|p)\b/gi, // Short language/misc tags
  ];

  // 4. Apply junk patterns
  junkPatterns.forEach(pattern => {
    title = title.replace(pattern, "");
  });

  // 5. Final Formatting
  // Trim extra spaces
  title = title.replace(/\s+/g, " ").trim();

  // If the result is empty (unlikely but possible), fallback to raw filename
  if (!title) return filename;

  // Capitalize first letter of each word
  return title
    .split(" ")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
};
