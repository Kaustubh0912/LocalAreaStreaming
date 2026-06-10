import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(__dirname, '../../data/config.json');

export interface AppConfig {
  movieFolderPaths: string[];
}

const defaultConfig: AppConfig = {
  movieFolderPaths: [],
};

export const getConfig = (): AppConfig => {
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    // Migration: if old config has movieFolderPath, convert to movieFolderPaths
    if (parsed.movieFolderPath && !parsed.movieFolderPaths) {
      return { movieFolderPaths: [parsed.movieFolderPath] };
    }
    return parsed;
  } catch (e) {
    return defaultConfig;
  }
};

export const saveConfig = (config: AppConfig) => {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
};
