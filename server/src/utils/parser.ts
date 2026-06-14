export const parseMovieTitle = (filename: string): string => {
  let title = filename.replace(/\.[^/.]+$/, "");

  title = title.replace(/[\._\-\[\]\(\)]/g, " ");

  const junkPatterns = [
    /\b\d{4}\b/g,
    /\b(1080p|720p|2160p|4k|5k|8k|hd|sd|imax|hdr|hdr10|dovi|dv)\b/gi,
    /\b(bluray|brrip|bdrip|web-dl|webrip|hdtv|dvdrip|dvd|cam|ts|hc)\b/gi,
    /\b(x264|x265|h264|hevc|10bit|avc|vc1)\b/gi,
    /\b(dts|aac|ac3|truehd|dts-hd|atmos)\d?(\s?1)?\b/gi,
    /\b([57]\s?1|ch)\b/gi,
    /\b(proper|repack|limited|unrated|extended|remastered|multi|subs?|dual)\b/gi,
    /\b(directors\s?cut|theatrical|collector|anniversary)\b/gi,
    /\b(yts|yify|rarbg|ettv|shaanig|psigig|tgx|vppv|ion10|bz|psig)\b/gi,
    /\b(mx|es|en|fr|jp|ko|hi|p)\b/gi,
  ];

  junkPatterns.forEach(pattern => {
    title = title.replace(pattern, "");
  });

  title = title.replace(/\s+/g, " ").trim();

  if (!title) return filename;

  return title
    .split(" ")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
};
