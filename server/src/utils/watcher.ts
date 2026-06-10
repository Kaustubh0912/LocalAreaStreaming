import chokidar from 'chokidar';
import { getConfig } from './config';

let watcher: chokidar.FSWatcher | null = null;
let onChangeCallback: (() => void) | null = null;

export const initWatcher = (callback: () => void) => {
  onChangeCallback = callback;
  updateWatcher();
};

export const updateWatcher = () => {
  if (watcher) {
    watcher.close();
  }

  const config = getConfig();
  if (!config.movieFolderPaths || config.movieFolderPaths.length === 0) return;

  watcher = chokidar.watch(config.movieFolderPaths, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on('add', () => onChangeCallback?.());
  watcher.on('unlink', () => onChangeCallback?.());
  watcher.on('addDir', () => onChangeCallback?.());
  watcher.on('unlinkDir', () => onChangeCallback?.());
};
