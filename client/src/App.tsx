import { useState, useEffect, useRef } from 'react'
import Hls from 'hls.js'
import './App.css'

interface Movie {
  id: string;
  title: string;
  rawTitle: string;
  poster: string;
  size: number;
  mtime: number;
  progress: {
    currentTime: number;
    duration: number;
  } | null;
  watched: boolean;
  hasSubtitles: boolean;
}

interface Config {
  movieFolderPaths: string[];
}

function App() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [config, setConfig] = useState<Config>({ movieFolderPaths: [] });
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [newPath, setNewPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'title' | 'date' | 'size'>('date');
  const [useTranscoding, setUseTranscoding] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const progressInterval = useRef<number | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const API_BASE = import.meta.env.PROD ? '/api' : `http://${window.location.hostname}:5000/api`;

  useEffect(() => {
    fetchConfig();
    const eventSource = new EventSource(`${API_BASE}/events`);
    eventSource.onmessage = (e) => {
      if (e.data === 'update') fetchMovies();
    };
    return () => eventSource.close();
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/config`);
      const data = await res.json();
      setConfig(data);
      if (data.movieFolderPaths?.length > 0) fetchMovies();
      else setShowSettings(true);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  const fetchMovies = async () => {
    try {
      const res = await fetch(`${API_BASE}/movies`);
      const data = await res.json();
      setMovies(data);
    } catch (err) { console.error(err); }
  };

  const updatePaths = async (paths: string[]) => {
    await fetch(`${API_BASE}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movieFolderPaths: paths })
    });
    fetchConfig();
  };

  const toggleWatched = async (e: React.MouseEvent, movieId: string) => {
    e.stopPropagation();
    
    // Optimistic UI Update
    setMovies(prev => prev.map(m => m.id === movieId ? { ...m, watched: !m.watched } : m));
    if (selectedMovie && selectedMovie.id === movieId) {
      setSelectedMovie({ ...selectedMovie, watched: !selectedMovie.watched });
    }

    try {
      await fetch(`${API_BASE}/movies/${movieId}/watched`, { method: 'POST' });
    } catch (err) {
      console.error(err);
      fetchMovies();
    }
  };

  const saveProgress = async (movieId: string, currentTime: number, duration: number) => {
    if (!duration || duration < 1) return;
    await fetch(`${API_BASE}/movies/${movieId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentTime, duration })
    });
  };

  // Video Player Logic
  useEffect(() => {
    if (selectedMovie && videoRef.current) {
      const video = videoRef.current;
      const streamUrl = useTranscoding 
        ? `${API_BASE}/stream/${selectedMovie.id}/vod.m3u8`
        : `${API_BASE}/stream/${selectedMovie.id}`;

      if (useTranscoding) {
        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(streamUrl);
          hls.attachMedia(video);
          hlsRef.current = hls;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (selectedMovie.progress) video.currentTime = selectedMovie.progress.currentTime;
            video.play();
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Native HLS support (Safari)
          video.src = streamUrl;
          video.addEventListener('loadedmetadata', () => {
            if (selectedMovie.progress) video.currentTime = selectedMovie.progress.currentTime;
            video.play();
          });
        }
      } else {
        video.src = streamUrl;
        if (selectedMovie.progress) video.currentTime = selectedMovie.progress.currentTime;
        video.play();
      }

      progressInterval.current = window.setInterval(() => {
        if (!video.paused && video.duration > 0) {
          saveProgress(selectedMovie.id, video.currentTime, video.duration);
        }
      }, 5000);
    }

    return () => {
      if (progressInterval.current) clearInterval(progressInterval.current);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [selectedMovie, useTranscoding]);

  const filteredMovies = movies
    .filter(m => m.title.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'title') return a.title.localeCompare(b.title);
      if (sortBy === 'date') return b.mtime - a.mtime;
      if (sortBy === 'size') return b.size - a.size;
      return 0;
    });

  if (loading) return <div className="loading-screen">LAS MEDIA SERVER</div>;

  return (
    <div className="app-container">
      <nav className="top-nav">
        <div className="nav-left">
          <h1>LAS</h1>
          <div className="search-container">
            <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <input className="search-input" type="text" placeholder="Search library..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </div>
        </div>
        <div className="nav-right">
          <div className="sort-container">
            <span>Sort by:</span>
            <select className="sort-select" value={sortBy} onChange={(e: any) => setSortBy(e.target.value)}>
              <option value="date">Recently Added</option>
              <option value="title">Alphabetical</option>
              <option value="size">File Size</option>
            </select>
          </div>
          <button className="settings-btn" onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </nav>

      <main className="main-content">
        <div className="movie-grid">
          {filteredMovies.map(movie => (
            <article key={movie.id} className="movie-card" onClick={() => setSelectedMovie(movie)}>
              <div className="poster-box">
                <div className="poster-title-container">
                  <span className="poster-title-text">{movie.title}</span>
                </div>
                {movie.watched && <div className="watched-indicator">✓</div>}
                <div className="movie-overlay"><div className="play-circle">▶</div></div>
                {movie.progress && <div className="progress-track"><div className="progress-fill" style={{ width: `${(movie.progress.currentTime / movie.progress.duration) * 100}%` }} /></div>}
              </div>
              <div className="movie-info">
                <h3>{movie.title}</h3>
                <div className="meta-tags">
                  <span>{Math.round(movie.size / (1024 * 1024))} MB</span>
                  {movie.hasSubtitles && <span>• CC</span>}
                </div>
              </div>
            </article>
          ))}
        </div>
      </main>

      {showSettings && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <h2>Library Settings</h2>
            <div style={{ margin: '1.5rem 0' }}>
              {config.movieFolderPaths.map(p => (
                <div key={p} className="path-item" style={{ background: 'var(--bg)', padding: '0.8rem', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '0.85rem' }}>{p}</span>
                  <button onClick={() => updatePaths(config.movieFolderPaths.filter(x => x !== p))} style={{ color: '#ff4d4d', background: 'transparent', border: 'none', cursor: 'pointer' }}>Remove</button>
                </div>
              ))}
            </div>
            <div className="input-group">
              <input className="input-field" type="text" placeholder="Add local folder path..." value={newPath} onChange={(e) => setNewPath(e.target.value)} />
              <button className="action-btn" onClick={() => { updatePaths([...config.movieFolderPaths, newPath]); setNewPath(''); }}>Add Folder</button>
            </div>
            <button className="settings-btn" style={{ width: '100%', marginTop: '1.5rem', background: 'var(--surface-lift)' }} onClick={() => setShowSettings(false)}>Done</button>
          </div>
        </div>
      )}

      {selectedMovie && (
        <div className="player-root">
          <header className="player-header">
            <div className="player-info">
              <button className="exit-btn" onClick={() => setSelectedMovie(null)}>←</button>
              <span className="player-title-text">{selectedMovie.title}</span>
            </div>
            <div className="player-actions">
              <button className={`action-chip ${selectedMovie.watched ? 'active' : ''}`} onClick={(e) => toggleWatched(e, selectedMovie.id)}>
                {selectedMovie.watched ? '✓ Watched' : 'Mark Watched'}
              </button>
              <button className={`action-chip ${useTranscoding ? 'active' : ''}`} onClick={() => setUseTranscoding(!useTranscoding)}>
                Compatibility Mode
              </button>
            </div>
          </header>
          <div className="video-container">
            <video ref={videoRef} controls crossOrigin="anonymous">
              {/* Note: src is handled by the useEffect above */}
              {selectedMovie.hasSubtitles && (
                <track key={selectedMovie.id} label="English" kind="subtitles" srcLang="en" src={`${API_BASE}/subtitles/${selectedMovie.id}`} default />
              )}
            </video>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
