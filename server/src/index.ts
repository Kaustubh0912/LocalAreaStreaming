import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { getConfig, saveConfig } from './utils/config';
import { getDb, updateProgress, toggleWatched } from './utils/db';
import { parseMovieTitle } from './utils/parser';
import { initWatcher, updateWatcher } from './utils/watcher';
import { probeMedia } from './utils/probe';

dotenv.config();

// Get MIME type based on file extension
const getMimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.mkv': return 'video/x-matroska';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.avi': return 'video/x-msvideo';
    case '.flv': return 'video/x-flv';
    case '.wmv': return 'video/x-ms-wmv';
    default: return 'video/mp4'; // Fallback to mp4
  }
};

const app = express();
const PORT = parseInt(process.env.PORT as string, 10) || 5000;
const SEGMENT_DURATION = 10; // seconds

app.use(cors());
app.use(express.json());

let clients: any[] = [];

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
        const folder = path.dirname(itemPath);
        const movieName = path.parse(item.name).name;
        const potentialSubs = fs.readdirSync(folder)
          .filter(f => f.toLowerCase().endsWith('.srt') && f.toLowerCase().startsWith(movieName.toLowerCase()));
        
        results.push({
          filename: item.name,
          fullPath: itemPath,
          relPath: relPath,
          baseDir: baseDir,
          size: stats.size,
          mtime: stats.mtimeMs,
          hasSubtitles: potentialSubs.length > 0
        });
      }
    }
  }
  return results;
};

// SSE
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const clientId = Date.now();
  clients.push({ id: clientId, res });
  req.on('close', () => { clients = clients.filter(c => c.id !== clientId); });
});

const notifyClients = () => clients.forEach(c => c.res.write('data: update\n\n'));
initWatcher(notifyClients);

// API Routes
app.get('/api/config', (req, res) => res.json(getConfig()));
app.post('/api/config', (req, res) => {
  const { movieFolderPaths } = req.body;
  if (!Array.isArray(movieFolderPaths)) return res.status(400).send('Invalid');
  saveConfig({ movieFolderPaths: movieFolderPaths.filter(p => fs.existsSync(p)) });
  updateWatcher();
  notifyClients();
  res.json({ success: true });
});

app.get('/api/movies', async (req, res) => {
  const config = getConfig();
  const db = getDb();
  if (!config.movieFolderPaths?.length) return res.json([]);
  
  let allMovies: any[] = [];
  for (const folder of config.movieFolderPaths) {
    const rawMovies = getMediaFilesRecursive(folder, folder);
    for (const m of rawMovies) {
      const id = Buffer.from(`${m.baseDir}|${m.relPath}`).toString('base64');
      const title = parseMovieTitle(m.filename);
      
      // Probing is slow, so ideally we'd cache this in db.json
      // For now, we'll do it on the fly but keep it simple
      const info = await probeMedia(m.fullPath);

      allMovies.push({
        id, title, poster: `https://images.placeholders.dev/?width=400&height=600&text=${encodeURIComponent(title)}&bgColor=%231f1f1f&textColor=%23e5e5e5&fontSize=32`,
        size: m.size, mtime: m.mtime, duration: info.duration,
        progress: db.progress[id] || null, watched: db.watched.includes(id), hasSubtitles: m.hasSubtitles
      });
    }
  }
  res.json(allMovies);
});

app.post('/api/movies/:id/progress', (req, res) => {
  updateProgress(req.params.id, req.body.currentTime, req.body.duration);
  notifyClients();
  res.json({ success: true });
});

app.post('/api/movies/:id/watched', (req, res) => {
  toggleWatched(req.params.id);
  notifyClients();
  res.json({ success: true });
});

app.get('/api/subtitles/:id', (req, res) => {
  try {
    const decoded = Buffer.from(req.params.id, 'base64').toString('ascii');
    const [baseDir, relPath] = decoded.split('|');
    const moviePath = path.join(baseDir, relPath);
    const folder = path.dirname(moviePath);
    const movieName = path.parse(moviePath).name;
    const subs = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.srt') && f.toLowerCase().startsWith(movieName.toLowerCase()));
    if (subs.length) {
      res.setHeader('Content-Type', 'text/vtt');
      res.send('WEBVTT\n\n' + fs.readFileSync(path.join(folder, subs[0]), 'utf-8').replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'));
    } else res.status(404).send('No');
  } catch (e) { res.status(500).send('Err'); }
});

// Dynamic HLS VOD Manifest
const activeTranscodes: Record<string, { process: any, targetIndex: number }> = {};
const HLS_CACHE = path.join(__dirname, '../../data/hls');
if (!fs.existsSync(HLS_CACHE)) fs.mkdirSync(HLS_CACHE, { recursive: true });

app.get('/api/stream/:id/vod.m3u8', async (req, res) => {
  try {
    const decoded = Buffer.from(req.params.id, 'base64').toString('ascii');
    const [baseDir, relPath] = decoded.split('|');
    const filePath = path.join(baseDir, relPath);
    
    const info = await probeMedia(filePath);
    const duration = info.duration;
    const numSegments = Math.ceil(duration / SEGMENT_DURATION);

    let manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MEDIA-SEQUENCE:0',
    ];

    for (let i = 0; i < numSegments; i++) {
      const segLen = (i === numSegments - 1) ? (duration % SEGMENT_DURATION) : SEGMENT_DURATION;
      manifest.push(`#EXTINF:${segLen.toFixed(3)},`);
      manifest.push(`segment/${i}.ts`);
    }

    manifest.push('#EXT-X-ENDLIST');
    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.send(manifest.join('\n'));
  } catch (e) { res.status(500).send('Error'); }
});

// Transcode specific HLS segment on the fly
app.get('/api/stream/:id/segment/:index.ts', (req, res) => {
  try {
    const decoded = Buffer.from(req.params.id, 'base64').toString('ascii');
    const [baseDir, relPath] = decoded.split('|');
    const filePath = path.join(baseDir, relPath);
    const index = parseInt(req.params.index, 10);
    const startTime = index * SEGMENT_DURATION;

    const sessionDir = path.join(HLS_CACHE, req.params.id);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    const segPath = path.join(sessionDir, `segment_${index}.ts`);

    if (fs.existsSync(segPath)) {
      return res.sendFile(segPath);
    }

    if (activeTranscodes[req.params.id]) {
      const diff = index - activeTranscodes[req.params.id].targetIndex;
      if (diff < 0 || diff > 5) {
        // Seeked far away, kill current process
        activeTranscodes[req.params.id].process.kill('SIGKILL');
        delete activeTranscodes[req.params.id];
      } else {
        // Keep alive and update target
        activeTranscodes[req.params.id].targetIndex = Math.max(activeTranscodes[req.params.id].targetIndex, index);
      }
    }

    if (!activeTranscodes[req.params.id]) {
      const ffmpeg = spawn('ffmpeg', [
        '-ss', startTime.toString(),
        '-i', filePath,
        '-copyts',
        '-c:v', 'libx264', '-preset', 'superfast', '-crf', '26',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-f', 'hls',
        '-hls_time', SEGMENT_DURATION.toString(),
        '-hls_list_size', '0',
        '-start_number', index.toString(),
        '-hls_flags', 'temp_file',
        '-hls_segment_filename', path.join(sessionDir, 'segment_%d.ts'),
        path.join(sessionDir, 'stream.m3u8')
      ]);

      activeTranscodes[req.params.id] = { process: ffmpeg, targetIndex: index };

      ffmpeg.on('exit', () => {
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
      } else if (checks > 150) { // 30 seconds max
        clearInterval(interval);
        if (!res.headersSent) res.status(500).send('Timeout');
      }
      checks++;
    }, 200);

  } catch (e) {
    console.error('HLS segment transcoding error:', e);
    res.status(500).send('Error');
  }
});

// Direct Stream (Scrubbable for MP4/WebM)
app.get('/api/stream/:id', (req, res) => {
  try {
    const decoded = Buffer.from(req.params.id, 'base64').toString('ascii');
    const [baseDir, relPath] = decoded.split('|');
    const filePath = path.join(baseDir, relPath);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const mimeType = getMimeType(filePath);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': (end - start) + 1, 'Content-Type': mimeType });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': mimeType });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) { res.status(500).send('Error'); }
});

// Serve frontend in production
const publicPath = path.join(__dirname, '../../public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
  // Use a middleware instead of '*' route to catch all remaining GET requests
  // This avoids the Express 5 / path-to-regexp 'Missing parameter name' error
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(path.join(publicPath, 'index.html'));
    } else {
      next();
    }
  });
} else {
  console.log(`Warning: Frontend build not found at ${publicPath}`);
}

app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on 0.0.0.0:${PORT}`));
