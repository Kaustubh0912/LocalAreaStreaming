import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(__dirname, '../../data/db.json');

export interface MovieProgress {
  currentTime: number;
  duration: number;
  updatedAt: number;
}

export interface DbSchema {
  progress: Record<string, MovieProgress>;
  watched: string[];
}

const defaultDb: DbSchema = {
  progress: {},
  watched: [],
};

export const getDb = (): DbSchema => {
  if (!fs.existsSync(DB_PATH)) {
    saveDb(defaultDb);
    return defaultDb;
  }
  try {
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return defaultDb;
  }
};

export const saveDb = (db: DbSchema) => {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
};

export const updateProgress = (movieId: string, currentTime: number, duration: number) => {
  const db = getDb();
  db.progress[movieId] = {
    currentTime,
    duration,
    updatedAt: Date.now(),
  };
  saveDb(db);
};

export const toggleWatched = (movieId: string) => {
  const db = getDb();
  const index = db.watched.indexOf(movieId);
  if (index === -1) {
    db.watched.push(movieId);
  } else {
    db.watched.splice(index, 1);
  }
  saveDb(db);
};
