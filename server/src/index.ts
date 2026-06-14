import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { getConfig, saveConfig } from "./utils/config";
import {
  getCachedPoster,
  getDb,
  toggleWatched,
  updatePosterCache,
  updateProgress,
} from "./utils/db";
import { parseMovieTitle } from "./utils/parser";
import { initWatcher, updateWatcher } from "./utils/watcher";
import { probeMedia } from "./utils/probe";

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

let isNvencAvailable = false;
try {
  const result = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc",
    "-c:v",
    "h264_nvenc",
    "-vframes",
    "1",
    "-f",
    "null",
    "-",
  ]);
  isNvencAvailable = result.status === 0;
  console.log(
    `[SYS] Hardware Acceleration (NVENC) Detected: ${isNvencAvailable}`,
  );
} catch (e) {
  console.log(
    `[SYS] Hardware Acceleration (NVENC) Detected: false (Failed to probe)`,
  );
}

const getMimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".mkv":
      return "video/x-matroska";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".avi":
      return "video/x-msvideo";
    case ".flv":
      return "video/x-flv";
    case ".wmv":
      return "video/x-ms-wmv";
    default:
      return "video/mp4";
  }
};

const app = express();
const PORT = parseInt(process.env.PORT as string, 10) || 5000;
const SEGMENT_DURATION = 10;
const POSTER_CACHE_TTL = 1000 * 60 * 60 * 24 * 30;
const MISSING_POSTER_CACHE_TTL = 1000 * 60 * 60 * 12;
const AUTO_SUBTITLE_CACHE = path.join(__dirname, "../../data/subtitles");

app.use(cors());
app.use(express.json());

let clients: any[] = [];

const EXTERNAL_SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt"]);
const LOCAL_POSTER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const LOCAL_POSTER_NAMES = new Set(["poster", "cover", "folder"]);
const EXTRACTABLE_SUBTITLE_CODECS = new Set([
  "subrip",
  "ass",
  "ssa",
  "webvtt",
  "mov_text",
]);

const normalizeMediaName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\s._-]+/g, " ")
    .trim();

const findExternalSubtitle = (moviePath: string) => {
  const folder = path.dirname(moviePath);
  const movieName = path.parse(moviePath).name;
  const normalizedMovieName = normalizeMediaName(movieName);

  if (!fs.existsSync(folder)) return null;

  const candidates = fs
    .readdirSync(folder)
    .filter((file) =>
      EXTERNAL_SUBTITLE_EXTENSIONS.has(path.extname(file).toLowerCase()),
    )
    .map((file) => ({
      file,
      normalizedBase: normalizeMediaName(path.parse(file).name),
    }))
    .filter(
      ({ normalizedBase }) =>
        normalizedBase === normalizedMovieName ||
        normalizedBase.startsWith(`${normalizedMovieName} `) ||
        normalizedMovieName.startsWith(`${normalizedBase} `),
    )
    .sort((a, b) => a.file.localeCompare(b.file));

  return candidates.length ? path.join(folder, candidates[0].file) : null;
};

const findLocalPoster = (moviePath: string) => {
  const folder = path.dirname(moviePath);
  const movieName = path.parse(moviePath).name;
  const normalizedMovieName = normalizeMediaName(movieName);

  if (!fs.existsSync(folder)) return null;

  const candidates = fs
    .readdirSync(folder)
    .filter((file) =>
      LOCAL_POSTER_EXTENSIONS.has(path.extname(file).toLowerCase()),
    )
    .map((file) => ({
      file,
      baseName: path.parse(file).name.toLowerCase(),
      normalizedBase: normalizeMediaName(path.parse(file).name),
    }))
    .filter(
      ({ baseName, normalizedBase }) =>
        LOCAL_POSTER_NAMES.has(baseName) ||
        normalizedBase === normalizedMovieName ||
        normalizedBase.startsWith(`${normalizedMovieName} `),
    )
    .sort((a, b) => {
      const aGeneric = LOCAL_POSTER_NAMES.has(a.baseName) ? 0 : 1;
      const bGeneric = LOCAL_POSTER_NAMES.has(b.baseName) ? 0 : 1;
      return aGeneric - bGeneric || a.file.localeCompare(b.file);
    });

  return candidates.length ? path.join(folder, candidates[0].file) : null;
};

const getImageMimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
};

const getMovieYear = (filename: string) =>
  filename.match(/\b(19|20)\d{2}\b/)?.[0];

const getTmdbPoster = async (
  movieId: string,
  title: string,
  filename: string,
) => {
  const cached = getCachedPoster(movieId);
  if (cached?.poster && Date.now() - cached.updatedAt < POSTER_CACHE_TTL) {
    return cached.poster;
  }
  if (
    cached &&
    !cached.poster &&
    Date.now() - cached.updatedAt < MISSING_POSTER_CACHE_TTL
  ) {
    return undefined;
  }

  const apiKey = process.env.TMDB_API_KEY?.trim();
  if (!apiKey) return undefined;

  if (apiKey.endsWith(".env") || apiKey.endsWith(".env.example")) {
    console.warn(
      "TMDB_API_KEY looks like a file path. Put the actual TMDb API key value in .env, not the filename.",
    );
    return undefined;
  }

  try {
    const url = new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("query", title);
    url.searchParams.set("include_adult", "false");

    const year = getMovieYear(filename);
    if (year) url.searchParams.set("year", year);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`TMDb responded with ${response.status}`);

    const data = (await response.json()) as {
      results?: Array<{ poster_path?: string; popularity?: number }>;
    };
    const match = data.results
      ?.filter((result) => result.poster_path)
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
    const poster = match?.poster_path
      ? `https://image.tmdb.org/t/p/w500${match.poster_path}`
      : null;

    updatePosterCache(movieId, poster);
    return poster ?? undefined;
  } catch (error) {
    console.error(`TMDb poster lookup failed for ${title}:`, error);
    return undefined;
  }
};

const convertSrtToVtt = (content: string) => {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/^(\d+)\s*$/gm, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();

  return `WEBVTT\n\n${normalized}\n`;
};

const canExtractEmbeddedSubtitles = (codecs?: string[]) =>
  Boolean(codecs?.some((codec) => EXTRACTABLE_SUBTITLE_CODECS.has(codec)));

const isAutoSubtitleEnabled = () =>
  Boolean(process.env.OPENSUBTITLES_API_KEY?.trim());

const getSafeCacheKey = (value: string) =>
  crypto.createHash("sha1").update(value).digest("hex");

const getCachedAutoSubtitlePath = (movieId: string) => {
  const base = path.join(AUTO_SUBTITLE_CACHE, getSafeCacheKey(movieId));
  const vtt = `${base}.vtt`;
  const srt = `${base}.srt`;

  if (fs.existsSync(vtt)) return vtt;
  if (fs.existsSync(srt)) return srt;
  return null;
};

const getOpenSubtitlesHeaders = () => ({
  "Api-Key": process.env.OPENSUBTITLES_API_KEY?.trim() ?? "",
  "User-Agent": process.env.OPENSUBTITLES_USER_AGENT?.trim() || "LAS v1",
});

const fetchOpenSubtitlesDownloadLink = async (
  title: string,
  filename: string,
) => {
  const apiKey = process.env.OPENSUBTITLES_API_KEY?.trim();
  if (!apiKey) return null;

  const searchUrl = new URL("https://api.opensubtitles.com/api/v1/subtitles");
  searchUrl.searchParams.set("languages", "en");
  searchUrl.searchParams.set("query", title);

  const year = getMovieYear(filename);
  if (year) searchUrl.searchParams.set("year", year);

  const searchResponse = await fetch(searchUrl, {
    headers: getOpenSubtitlesHeaders(),
  });
  if (!searchResponse.ok) {
    throw new Error(
      `OpenSubtitles search responded with ${searchResponse.status}`,
    );
  }

  const searchData = (await searchResponse.json()) as {
    data?: Array<{
      attributes?: {
        download_count?: number;
        hearing_impaired?: boolean;
        files?: Array<{ file_id?: number }>;
      };
    }>;
  };

  const match = searchData.data
    ?.flatMap((item) =>
      (item.attributes?.files ?? [])
        .filter((file) => file.file_id)
        .map((file) => ({
          fileId: file.file_id as number,
          hearingImpaired: Boolean(item.attributes?.hearing_impaired),
          downloadCount: item.attributes?.download_count ?? 0,
        })),
    )
    .sort(
      (a, b) =>
        Number(b.hearingImpaired) - Number(a.hearingImpaired) ||
        b.downloadCount - a.downloadCount,
    )[0];

  if (!match) return null;

  const downloadResponse = await fetch(
    "https://api.opensubtitles.com/api/v1/download",
    {
      method: "POST",
      headers: {
        ...getOpenSubtitlesHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_id: match.fileId }),
    },
  );

  if (!downloadResponse.ok) {
    throw new Error(
      `OpenSubtitles download responded with ${downloadResponse.status}`,
    );
  }

  const downloadData = (await downloadResponse.json()) as { link?: string };
  return downloadData.link ?? null;
};

const fetchAutoSubtitle = async (
  movieId: string,
  title: string,
  filename: string,
) => {
  const cachedPath = getCachedAutoSubtitlePath(movieId);
  if (cachedPath) return cachedPath;
  if (!isAutoSubtitleEnabled()) return null;

  try {
    const downloadLink = await fetchOpenSubtitlesDownloadLink(title, filename);
    if (!downloadLink) return null;

    const subtitleResponse = await fetch(downloadLink);
    if (!subtitleResponse.ok) {
      throw new Error(
        `OpenSubtitles file download responded with ${subtitleResponse.status}`,
      );
    }

    const subtitleText = await subtitleResponse.text();
    const isVtt = subtitleText.trimStart().startsWith("WEBVTT");
    const cachePath = path.join(
      AUTO_SUBTITLE_CACHE,
      `${getSafeCacheKey(movieId)}.${isVtt ? "vtt" : "srt"}`,
    );

    if (!fs.existsSync(AUTO_SUBTITLE_CACHE))
      fs.mkdirSync(AUTO_SUBTITLE_CACHE, { recursive: true });
    fs.writeFileSync(cachePath, subtitleText);
    return cachePath;
  } catch (error) {
    console.error(`OpenSubtitles lookup failed for ${title}:`, error);
    return null;
  }
};

// Recursive file search
const getMediaFilesRecursive = (dir: string, baseDir: string): any[] => {
  let results: any[] = [];
  if (!fs.existsSync(dir)) return [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const itemPath = path.join(dir, item.name);
    const relPath = path.relative(baseDir, itemPath);
    if (item.isDirectory()) {
      results = results.concat(getMediaFilesRecursive(itemPath, baseDir));
    } else if (item.isFile()) {
      if (/\.(mp4|mkv|webm|avi|mov)$/i.test(item.name)) {
        const stats = fs.statSync(itemPath);
        const externalSubtitle = findExternalSubtitle(itemPath);
        const localPoster = findLocalPoster(itemPath);

        results.push({
          filename: item.name,
          fullPath: itemPath,
          relPath: relPath,
          baseDir: baseDir,
          size: stats.size,
          mtime: stats.mtimeMs,
          hasSubtitles: Boolean(externalSubtitle),
          hasPoster: Boolean(localPoster),
        });
      }
    }
  }
  return results;
};

// SSE
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const clientId = Date.now();
  clients.push({ id: clientId, res });
  req.on("close", () => {
    clients = clients.filter((c) => c.id !== clientId);
  });
});

const notifyClients = () =>
  clients.forEach((c) => c.res.write("data: update\n\n"));
initWatcher(notifyClients);

app.get("/api/config", (req, res) => res.json(getConfig()));
app.post("/api/config", (req, res) => {
  const { movieFolderPaths } = req.body;
  if (!Array.isArray(movieFolderPaths)) return res.status(400).send("Invalid");
  saveConfig({
    movieFolderPaths: movieFolderPaths.filter((p) => fs.existsSync(p)),
  });
  updateWatcher();
  notifyClients();
  res.json({ success: true });
});

app.get("/api/movies", async (req, res) => {
  const config = getConfig();
  const db = getDb();
  if (!config.movieFolderPaths?.length) return res.json([]);

  let allMovies: any[] = [];
  for (const folder of config.movieFolderPaths) {
    const rawMovies = getMediaFilesRecursive(folder, folder);
    for (const m of rawMovies) {
      const id = Buffer.from(`${m.baseDir}|${m.relPath}`).toString("base64");
      const title = parseMovieTitle(m.filename);

      const info = await probeMedia(m.fullPath);

      allMovies.push({
        id,
        title,
        poster: m.hasPoster
          ? `/api/posters/${encodeURIComponent(id)}`
          : await getTmdbPoster(id, title, m.filename),
        size: m.size,
        mtime: m.mtime,
        duration: info.duration,
        progress: db.progress[id] || null,
        watched: db.watched.includes(id),
        hasSubtitles:
          m.hasSubtitles ||
          canExtractEmbeddedSubtitles(info.subtitleCodecs) ||
          isAutoSubtitleEnabled(),
      });
    }
  }
  res.json(allMovies);
});

app.post("/api/movies/:id/progress", (req, res) => {
  updateProgress(req.params.id, req.body.currentTime, req.body.duration);
  notifyClients();
  res.json({ success: true });
});

app.post("/api/movies/:id/watched", (req, res) => {
  toggleWatched(req.params.id);
  notifyClients();
  res.json({ success: true });
});

app.get("/api/posters/:id", (req, res) => {
  try {
    const decoded = Buffer.from(req.params.id, "base64").toString("ascii");
    const [baseDir, relPath] = decoded.split("|");
    const moviePath = path.join(baseDir, relPath);
    const posterPath = findLocalPoster(moviePath);

    if (!posterPath || !fs.existsSync(posterPath)) {
      return res.status(404).send("No poster");
    }

    res.setHeader("Content-Type", getImageMimeType(posterPath));
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(posterPath);
  } catch (e) {
    res.status(500).send("Err");
  }
});

app.get("/api/subtitles/:id", async (req, res) => {
  try {
    const movieId = req.params.id;
    const decoded = Buffer.from(movieId, "base64").toString("ascii");
    const [baseDir, relPath] = decoded.split("|");
    const moviePath = path.join(baseDir, relPath);
    const filename = path.basename(moviePath);
    const title = parseMovieTitle(filename);
    const externalSubtitle = findExternalSubtitle(moviePath);

    if (externalSubtitle) {
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");

      if (path.extname(externalSubtitle).toLowerCase() === ".vtt") {
        return res.send(fs.readFileSync(externalSubtitle, "utf-8"));
      }

      return res.send(
        convertSrtToVtt(fs.readFileSync(externalSubtitle, "utf-8")),
      );
    }

    const info = await probeMedia(moviePath);
    if (!canExtractEmbeddedSubtitles(info.subtitleCodecs)) {
      const autoSubtitle = await fetchAutoSubtitle(movieId, title, filename);
      if (!autoSubtitle) return res.status(404).send("No supported subtitles");

      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=86400");

      if (path.extname(autoSubtitle).toLowerCase() === ".vtt") {
        return res.send(fs.readFileSync(autoSubtitle, "utf-8"));
      }

      return res.send(convertSrtToVtt(fs.readFileSync(autoSubtitle, "utf-8")));
    }

    const ffmpeg = spawn("ffmpeg", [
      "-v",
      "error",
      "-i",
      moviePath,
      "-map",
      "0:s:0",
      "-f",
      "webvtt",
      "-",
    ]);

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    ffmpeg.stdout.pipe(res);

    req.on("close", () => ffmpeg.kill("SIGKILL"));
    ffmpeg.on("close", (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(422).send("Unsupported subtitle stream");
      }
    });
  } catch (e) {
    res.status(500).send("Err");
  }
});

// Dynamic HLS VOD Manifest
const activeTranscodes: Record<string, { process: any; targetIndex: number }> =
  {};
const HLS_CACHE = path.join(__dirname, "../../data/hls-stable");
if (!fs.existsSync(HLS_CACHE)) fs.mkdirSync(HLS_CACHE, { recursive: true });

app.get("/api/stream/:id/vod.m3u8", async (req, res) => {
  try {
    const decoded = Buffer.from(req.params.id, "base64").toString("ascii");
    const [baseDir, relPath] = decoded.split("|");
    const filePath = path.join(baseDir, relPath);

    const info = await probeMedia(filePath);
    const duration = info.duration;
    const numSegments = Math.ceil(duration / SEGMENT_DURATION);

    let manifest = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-MEDIA-SEQUENCE:0",
    ];

    for (let i = 0; i < numSegments; i++) {
      const segLen =
        i === numSegments - 1 ? duration % SEGMENT_DURATION : SEGMENT_DURATION;
      manifest.push(`#EXTINF:${segLen.toFixed(3)},`);
      manifest.push(`segment/${i}.ts`);
    }

    manifest.push("#EXT-X-ENDLIST");
    res.setHeader("Content-Type", "application/x-mpegURL");
    res.send(manifest.join("\n"));
  } catch (e) {
    res.status(500).send("Error");
  }
});

// Transcode specific HLS segment on the fly
app.get("/api/stream/:id/segment/:index.ts", async (req, res) => {
  try {
    const decoded = Buffer.from(req.params.id, "base64").toString("ascii");
    const [baseDir, relPath] = decoded.split("|");
    const filePath = path.join(baseDir, relPath);
    const index = parseInt(req.params.index, 10);
    const startTime = index * SEGMENT_DURATION;

    const sessionDir = path.join(HLS_CACHE, req.params.id);
    if (!fs.existsSync(sessionDir))
      fs.mkdirSync(sessionDir, { recursive: true });
    const segPath = path.join(sessionDir, `segment_${index}.ts`);

    if (fs.existsSync(segPath)) {
      return res.sendFile(segPath);
    }

    if (activeTranscodes[req.params.id]) {
      const diff = index - activeTranscodes[req.params.id].targetIndex;
      if (diff < 0 || diff > 12) {
        // Seeked far away, kill current process
        activeTranscodes[req.params.id].process.kill("SIGKILL");
        delete activeTranscodes[req.params.id];
      } else {
        // Keep alive and update target
        activeTranscodes[req.params.id].targetIndex = Math.max(
          activeTranscodes[req.params.id].targetIndex,
          index,
        );
      }
    }

    if (!activeTranscodes[req.params.id]) {
      const info = await probeMedia(filePath);
      const isH264 = info.codec === "h264";
      const useHWAccel = process.env.HW_ACCEL === "true";
      let videoArgs: string[];

      if (isH264) {
        videoArgs = ["-c:v", "copy"];
      } else if (useHWAccel && isNvencAvailable) {
        videoArgs = [
          "-hwaccel",
          "cuda",
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p1",
          "-cq",
          "23",
        ];
      } else {
        videoArgs = [
          "-c:v",
          "libx264",
          "-preset",
          "superfast",
          "-crf",
          "23",
          "-threads",
          "2",
        ];
      }

      const ffmpeg = spawn("ffmpeg", [
        "-ss",
        startTime.toString(),
        "-i",
        filePath,
        "-copyts",
        ...videoArgs,
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        "-f",
        "hls",
        "-hls_time",
        SEGMENT_DURATION.toString(),
        "-hls_list_size",
        "0",
        "-start_number",
        index.toString(),
        "-hls_flags",
        "temp_file",
        "-hls_segment_filename",
        path.join(sessionDir, "segment_%d.ts"),
        path.join(sessionDir, "stream.m3u8"),
      ]);

      activeTranscodes[req.params.id] = { process: ffmpeg, targetIndex: index };

      ffmpeg.on("exit", () => {
        if (activeTranscodes[req.params.id]?.process === ffmpeg) {
          delete activeTranscodes[req.params.id];
        }
      });
    }

    // Polling for the completed file
    let checks = 0;
    const interval = setInterval(() => {
      if (fs.existsSync(segPath)) {
        clearInterval(interval);
        res.sendFile(segPath);
      } else if (checks > 150) {
        // 30 seconds max
        clearInterval(interval);
        if (!res.headersSent) res.status(500).send("Timeout");
      }
      checks++;
    }, 200);
  } catch (e) {
    console.error("HLS segment transcoding error:", e);
    res.status(500).send("Error");
  }
});

// Direct Stream (Scrubbable for MP4/WebM)
app.get("/api/stream/:id", (req, res) => {
  try {
    const decoded = Buffer.from(req.params.id, "base64").toString("ascii");
    const [baseDir, relPath] = decoded.split("|");
    const filePath = path.join(baseDir, relPath);
    if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const mimeType = getMimeType(filePath);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": mimeType,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": mimeType,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    res.status(500).send("Error");
  }
});

// Serve frontend in production
const publicPath = path.join(__dirname, "../../public");
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
  // Use a middleware instead of '*' route to catch all remaining GET requests
  // This avoids the Express 5 / path-to-regexp 'Missing parameter name' error
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) {
      res.sendFile(path.join(publicPath, "index.html"));
    } else {
      next();
    }
  });
} else {
  console.log(`Warning: Frontend build not found at ${publicPath}`);
}

app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server listening on 0.0.0.0:${PORT}`),
);
