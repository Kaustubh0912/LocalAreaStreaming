import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import "./App.css";

type SortOption = "date" | "title" | "size";
type FilterOption = "all" | "continue" | "unwatched" | "watched" | "subtitles";

interface MovieProgress {
  currentTime: number;
  duration: number;
}

interface Movie {
  id: string;
  title: string;
  poster?: string;
  size: number;
  mtime: number;
  duration?: number;
  progress: MovieProgress | null;
  watched: boolean;
  hasSubtitles: boolean;
}

interface Config {
  movieFolderPaths: string[];
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }

  interface Navigator {
    standalone?: boolean;
  }
}

const API_BASE = import.meta.env.PROD
  ? "/api"
  : `http://${window.location.hostname}:5000/api`;

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;

  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
};

const formatDuration = (seconds?: number) => {
  if (!seconds || !Number.isFinite(seconds)) return "Unknown runtime";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours <= 0) return `${Math.max(1, minutes)}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

const formatDate = (timestamp: number) => {
  if (!Number.isFinite(timestamp)) return "Recently added";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
};

const getProgressPercent = (progress: MovieProgress | null) => {
  if (!progress?.duration) return 0;
  return Math.min(
    100,
    Math.max(0, (progress.currentTime / progress.duration) * 100),
  );
};

const getInitials = (title: string) =>
  title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0]?.toUpperCase())
    .join("") || "LAS";

const hasArtwork = (poster?: string) =>
  Boolean(poster && !poster.includes("images.placeholders.dev"));

const getPosterUrl = (poster?: string) => {
  if (!poster) return undefined;
  if (poster.startsWith("/api/")) return `${API_BASE}${poster.slice(4)}`;
  return poster;
};

const getPosterTitleSize = (title: string) => {
  const length = title.replace(/[^a-z0-9]/gi, "").length;

  if (length <= 16) return "clamp(1.2rem, 2.1vw, 1.55rem)";
  if (length <= 28) return "clamp(1rem, 1.75vw, 1.28rem)";
  if (length <= 44) return "clamp(0.82rem, 1.35vw, 1.02rem)";
  if (length <= 68) return "clamp(0.66rem, 1.08vw, 0.84rem)";
  return "clamp(0.54rem, 0.9vw, 0.7rem)";
};

function App() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [config, setConfig] = useState<Config>({ movieFolderPaths: [] });
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [newPath, setNewPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("date");
  const [filterBy, setFilterBy] = useState<FilterOption>("all");
  const [useTranscoding, setUseTranscoding] = useState(false);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const progressInterval = useRef<number | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean(navigator.standalone);

  const fetchMovies = useCallback(async () => {
    setIsRefreshing(true);

    try {
      const response = await fetch(`${API_BASE}/movies`);
      const data = (await response.json()) as Movie[];
      setMovies(data);
    } catch (error) {
      console.error("Failed to load movies:", error);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/config`);
      const data = (await response.json()) as Config;
      setConfig(data);

      if (data.movieFolderPaths?.length > 0) {
        await fetchMovies();
      } else {
        setShowSettings(true);
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    } finally {
      setLoading(false);
    }
  }, [fetchMovies]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      setDeferredPrompt(event);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    return () =>
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
  }, []);

  useEffect(() => {
    const loadInitialConfig = async () => {
      await fetchConfig();
    };

    void loadInitialConfig();

    const eventSource = new EventSource(`${API_BASE}/events`);
    eventSource.onmessage = (event) => {
      if (event.data === "update") void fetchMovies();
    };

    return () => eventSource.close();
  }, [fetchConfig, fetchMovies]);

  useEffect(() => {
    const closePlayer = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedMovie(null);
    };

    window.addEventListener("keydown", closePlayer);
    return () => window.removeEventListener("keydown", closePlayer);
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;

    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  };

  const showInstallInstructions = () => {
    if (isIOS) {
      alert(
        "To install LAS on iOS:\n\n1. Tap Safari's Share button.\n2. Scroll down and choose Add to Home Screen.\n3. Launch LAS from your home screen.",
      );
      return;
    }

    alert(
      "To install LAS on Android:\n\n1. Open Chrome menu.\n2. Tap Add to Home screen.\n3. Confirm the install prompt.",
    );
  };

  const updatePaths = async (paths: string[]) => {
    await fetch(`${API_BASE}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movieFolderPaths: paths }),
    });

    await fetchConfig();
  };

  const handleAddFolder = async () => {
    const trimmedPath = newPath.trim();
    if (!trimmedPath || config.movieFolderPaths.includes(trimmedPath)) return;

    await updatePaths([...config.movieFolderPaths, trimmedPath]);
    setNewPath("");
  };

  const toggleWatched = async (event: React.MouseEvent, movieId: string) => {
    event.stopPropagation();

    setMovies((currentMovies) =>
      currentMovies.map((movie) =>
        movie.id === movieId ? { ...movie, watched: !movie.watched } : movie,
      ),
    );
    setSelectedMovie((currentMovie) =>
      currentMovie?.id === movieId
        ? { ...currentMovie, watched: !currentMovie.watched }
        : currentMovie,
    );

    try {
      await fetch(`${API_BASE}/movies/${movieId}/watched`, { method: "POST" });
    } catch (error) {
      console.error("Failed to update watched state:", error);
      await fetchMovies();
    }
  };

  const saveProgress = useCallback(
    async (movieId: string, currentTime: number, duration: number) => {
      if (!duration || duration < 1) return;

      await fetch(`${API_BASE}/movies/${movieId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentTime, duration }),
      });
    },
    [],
  );

  useEffect(() => {
    if (!selectedMovie || !videoRef.current) return undefined;

    const video = videoRef.current;
    const streamUrl = useTranscoding
      ? `${API_BASE}/stream/${selectedMovie.id}/vod.m3u8`
      : `${API_BASE}/stream/${selectedMovie.id}`;

    const restoreAndPlay = () => {
      if (selectedMovie.progress)
        video.currentTime = selectedMovie.progress.currentTime;
      void video.play().catch(() => undefined);
    };

    video.pause();
    video.removeAttribute("src");
    video.load();

    if (useTranscoding) {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, restoreAndPlay);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamUrl;
        video.addEventListener("loadedmetadata", restoreAndPlay, {
          once: true,
        });
      }
    } else {
      video.src = streamUrl;
      video.addEventListener("loadedmetadata", restoreAndPlay, { once: true });
    }

    progressInterval.current = window.setInterval(() => {
      if (!video.paused && video.duration > 0) {
        void saveProgress(selectedMovie.id, video.currentTime, video.duration);
      }
    }, 5000);

    return () => {
      video.removeEventListener("loadedmetadata", restoreAndPlay);

      if (progressInterval.current) {
        clearInterval(progressInterval.current);
        progressInterval.current = null;
      }

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [saveProgress, selectedMovie, useTranscoding]);

  const stats = useMemo(() => {
    const totalSize = movies.reduce((sum, movie) => sum + movie.size, 0);
    const watchedCount = movies.filter((movie) => movie.watched).length;
    const continueCount = movies.filter(
      (movie) => movie.progress && !movie.watched,
    ).length;
    const subtitlesCount = movies.filter((movie) => movie.hasSubtitles).length;

    return { totalSize, watchedCount, continueCount, subtitlesCount };
  }, [movies]);

  const featuredMovie = useMemo(() => {
    const continueWatching = movies
      .filter((movie) => movie.progress && !movie.watched)
      .sort((first, second) => second.mtime - first.mtime);

    return (
      continueWatching[0] ??
      [...movies].sort((first, second) => second.mtime - first.mtime)[0] ??
      null
    );
  }, [movies]);

  const filteredMovies = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return movies
      .filter((movie) => {
        const matchesSearch = movie.title
          .toLowerCase()
          .includes(normalizedQuery);
        if (!matchesSearch) return false;
        if (filterBy === "continue")
          return Boolean(movie.progress && !movie.watched);
        if (filterBy === "unwatched") return !movie.watched;
        if (filterBy === "watched") return movie.watched;
        if (filterBy === "subtitles") return movie.hasSubtitles;
        return true;
      })
      .sort((first, second) => {
        if (sortBy === "title") return first.title.localeCompare(second.title);
        if (sortBy === "size") return second.size - first.size;
        return second.mtime - first.mtime;
      });
  }, [filterBy, movies, searchQuery, sortBy]);

  const filterOptions: Array<{
    id: FilterOption;
    label: string;
    count: number;
  }> = [
    { id: "all", label: "All", count: movies.length },
    { id: "continue", label: "Continue", count: stats.continueCount },
    {
      id: "unwatched",
      label: "Unwatched",
      count: movies.length - stats.watchedCount,
    },
    { id: "watched", label: "Watched", count: stats.watchedCount },
    { id: "subtitles", label: "Subtitles", count: stats.subtitlesCount },
  ];

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-mark">LAS</div>
        <p>Indexing your private cinema</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="hero-shell">
        <nav className="top-bar" aria-label="Primary navigation">
          <button
            className="brand-lockup"
            type="button"
            onClick={() => setFilterBy("all")}
            aria-label="Show all movies"
          >
            <span className="brand-glyph">▶</span>
            <span>
              <strong>LAS</strong>
              <small>Private media server</small>
            </span>
          </button>

          <div className="nav-actions">
            {deferredPrompt ? (
              <button
                className="pill-button accent"
                type="button"
                onClick={handleInstallClick}
              >
                Install app
              </button>
            ) : (isIOS || isAndroid) && !isStandalone ? (
              <button
                className="pill-button accent"
                type="button"
                onClick={showInstallInstructions}
              >
                Install app
              </button>
            ) : null}

            <button
              className="pill-button ghost"
              type="button"
              onClick={() => void fetchMovies()}
            >
              {isRefreshing ? "Scanning…" : "Rescan"}
            </button>
            <button
              className="pill-button"
              type="button"
              onClick={() => setShowSettings(true)}
            >
              Settings
            </button>
          </div>
        </nav>

        <section className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Local library</p>
            <h1>Your files. One clean shelf.</h1>
            <p className="hero-lede">
              Browse local folders, resume playback, track progress, and stream
              your collection without sending it anywhere else.
            </p>

            <div className="hero-controls">
              <label className="search-field">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  placeholder="Search your library"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </label>

              <label className="select-field">
                <span>Sort</span>
                <select
                  value={sortBy}
                  onChange={(event) =>
                    setSortBy(event.target.value as SortOption)
                  }
                >
                  <option value="date">Recently added</option>
                  <option value="title">A to Z</option>
                  <option value="size">Largest files</option>
                </select>
              </label>
            </div>
          </div>

          <aside className="spotlight-card" aria-label="Featured title">
            {featuredMovie ? (
              <>
                <div
                  className={`spotlight-art ${hasArtwork(featuredMovie.poster) ? "has-poster" : ""}`}
                  style={{
                    backgroundImage: hasArtwork(featuredMovie.poster)
                      ? `url(${getPosterUrl(featuredMovie.poster)})`
                      : undefined,
                  }}
                >
                  <span>{getInitials(featuredMovie.title)}</span>
                </div>
                <div className="spotlight-content">
                  <p className="eyebrow">
                    {featuredMovie.progress && !featuredMovie.watched
                      ? "Continue watching"
                      : "Recently added"}
                  </p>
                  <h2>{featuredMovie.title}</h2>
                  <div className="spotlight-meta">
                    <span>{formatDuration(featuredMovie.duration)}</span>
                    <span>{formatBytes(featuredMovie.size)}</span>
                    {featuredMovie.hasSubtitles && <span>CC</span>}
                  </div>
                  {featuredMovie.progress && (
                    <div
                      className="hero-progress"
                      aria-label={`${Math.round(getProgressPercent(featuredMovie.progress))}% watched`}
                    >
                      <span
                        style={{
                          width: `${getProgressPercent(featuredMovie.progress)}%`,
                        }}
                      />
                    </div>
                  )}
                  <button
                    className="primary-cta"
                    type="button"
                    onClick={() => setSelectedMovie(featuredMovie)}
                  >
                    {featuredMovie.progress && !featuredMovie.watched
                      ? "Continue watching"
                      : "Start watching"}
                  </button>
                </div>
              </>
            ) : (
              <div className="spotlight-empty">
                <span>+</span>
                <h2>Add a folder to start</h2>
                <p>
                  Point LAS at a local movie directory and it will index
                  playable files automatically.
                </p>
                <button
                  className="primary-cta"
                  type="button"
                  onClick={() => setShowSettings(true)}
                >
                  Open settings
                </button>
              </div>
            )}
          </aside>
        </section>

        <section className="stats-strip" aria-label="Library statistics">
          <div>
            <strong>{movies.length}</strong>
            <span>Titles</span>
          </div>
          <div>
            <strong>{stats.continueCount}</strong>
            <span>In progress</span>
          </div>
          <div>
            <strong>{stats.watchedCount}</strong>
            <span>Watched</span>
          </div>
          <div>
            <strong>{formatBytes(stats.totalSize)}</strong>
            <span>Indexed storage</span>
          </div>
        </section>
      </header>

      <main className="library-shell">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Browse</p>
            <h2>{filteredMovies.length} titles</h2>
          </div>
          <div
            className="filter-tabs"
            role="tablist"
            aria-label="Movie filters"
          >
            {filterOptions.map((option) => (
              <button
                key={option.id}
                className={filterBy === option.id ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={filterBy === option.id}
                onClick={() => setFilterBy(option.id)}
              >
                {option.label}
                <span>{option.count}</span>
              </button>
            ))}
          </div>
        </div>

        {filteredMovies.length > 0 ? (
          <div className="movie-grid">
            {filteredMovies.map((movie) => {
              const progressPercent = getProgressPercent(movie.progress);
              const movieHasArtwork = hasArtwork(movie.poster);

              return (
                <article
                  key={movie.id}
                  className="movie-card"
                  onClick={() => setSelectedMovie(movie)}
                >
                  <div
                    className={`poster-frame ${movieHasArtwork ? "has-poster" : ""}`}
                    style={{
                      backgroundImage: movieHasArtwork
                        ? `url(${getPosterUrl(movie.poster)})`
                        : undefined,
                    }}
                  >
                    <div className="poster-fallback">
                      <strong
                        style={{ fontSize: getPosterTitleSize(movie.title) }}
                      >
                        {movie.title}
                      </strong>
                    </div>

                    <div className="poster-topline">
                      {movie.watched && (
                        <span className="status-chip watched">Watched</span>
                      )}
                      {movie.hasSubtitles && (
                        <span className="status-chip">CC</span>
                      )}
                    </div>

                    <button
                      className={`watch-toggle ${movie.watched ? "active" : ""}`}
                      type="button"
                      onClick={(event) => void toggleWatched(event, movie.id)}
                      aria-label={
                        movie.watched
                          ? `Mark ${movie.title} as unwatched`
                          : `Mark ${movie.title} as watched`
                      }
                    >
                      ✓
                    </button>

                    <div className="poster-overlay">
                      <span className="play-orb">▶</span>
                      <small>
                        {movie.progress && !movie.watched ? "Resume" : "Play"}
                      </small>
                    </div>

                    {movie.progress && (
                      <div className="card-progress" aria-hidden="true">
                        <span style={{ width: `${progressPercent}%` }} />
                      </div>
                    )}
                  </div>

                  <div className="movie-details">
                    <h3>{movie.title}</h3>
                    <div className="movie-meta">
                      <span>{formatDuration(movie.duration)}</span>
                      <span>{formatBytes(movie.size)}</span>
                    </div>
                    <p>
                      {movie.progress && !movie.watched
                        ? `${Math.round(progressPercent)}% watched`
                        : `Added ${formatDate(movie.mtime)}`}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <section className="empty-state">
            <span>{config.movieFolderPaths.length > 0 ? "⌕" : "+"}</span>
            <h2>
              {config.movieFolderPaths.length > 0
                ? "No titles match that view"
                : "No library folders yet"}
            </h2>
            <p>
              {config.movieFolderPaths.length > 0
                ? "Try clearing search, switching filters, or rescanning your folders."
                : "Add a local movie directory to build your shelf."}
            </p>
            <button
              className="primary-cta"
              type="button"
              onClick={() => {
                if (config.movieFolderPaths.length > 0) {
                  setSearchQuery("");
                  setFilterBy("all");
                } else {
                  setShowSettings(true);
                }
              }}
            >
              {config.movieFolderPaths.length > 0 ? "Reset view" : "Add folder"}
            </button>
          </section>
        )}
      </main>

      {showSettings && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setShowSettings(false)}
        >
          <section
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Settings</p>
                <h2 id="settings-title">Folders & indexing</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowSettings(false)}
                aria-label="Close settings"
              >
                ×
              </button>
            </div>

            <div className="path-list">
              {config.movieFolderPaths.length > 0 ? (
                config.movieFolderPaths.map((path) => (
                  <div key={path} className="path-row">
                    <span>{path}</span>
                    <button
                      type="button"
                      onClick={() =>
                        void updatePaths(
                          config.movieFolderPaths.filter(
                            (currentPath) => currentPath !== path,
                          ),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))
              ) : (
                <div className="path-empty">
                  <strong>No folders connected</strong>
                  <span>
                    Add a directory path from this machine or mounted storage.
                  </span>
                </div>
              )}
            </div>

            <div className="folder-form">
              <label htmlFor="folder-path">New folder path</label>
              <div>
                <input
                  id="folder-path"
                  type="text"
                  placeholder="D:\\Movies or /media/movies"
                  value={newPath}
                  onChange={(event) => setNewPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleAddFolder();
                  }}
                />
                <button type="button" onClick={() => void handleAddFolder()}>
                  Add
                </button>
              </div>
            </div>

            <div className="settings-footer">
              <p>
                Paths are validated on the server. Connected folders are watched
                and the shelf refreshes when files change.
              </p>
              <button
                className="pill-button accent"
                type="button"
                onClick={() => setShowSettings(false)}
              >
                Done
              </button>
            </div>
          </section>
        </div>
      )}

      {selectedMovie && (
        <div className="player-root">
          <header className="player-header">
            <div className="player-title-group">
              <button
                className="player-back"
                type="button"
                onClick={() => setSelectedMovie(null)}
                aria-label="Close player"
              >
                ←
              </button>
              <div>
                <span>Now playing</span>
                <h2>{selectedMovie.title}</h2>
              </div>
            </div>

            <div className="player-actions">
              <button
                className={`action-chip ${selectedMovie.watched ? "active" : ""}`}
                type="button"
                onClick={(event) => void toggleWatched(event, selectedMovie.id)}
              >
                {selectedMovie.watched ? "Watched" : "Mark watched"}
              </button>
              <button
                className={`action-chip ${useTranscoding ? "active" : ""}`}
                type="button"
                onClick={() => setUseTranscoding((current) => !current)}
              >
                {useTranscoding ? "Compatibility on" : "Direct stream"}
              </button>
            </div>
          </header>

          <div className="video-stage">
            <video ref={videoRef} controls playsInline crossOrigin="anonymous">
              {selectedMovie.hasSubtitles && (
                <track
                  key={selectedMovie.id}
                  label="English"
                  kind="subtitles"
                  srcLang="en"
                  src={`${API_BASE}/subtitles/${selectedMovie.id}`}
                  default
                />
              )}
            </video>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
