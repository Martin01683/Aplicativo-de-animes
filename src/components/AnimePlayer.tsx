import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import Hls from 'hls.js';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FastForward,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Settings,
  Subtitles,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { StreamQuality, SubtitleTrack } from '../lib/types';
import {
  decodeSubtitleBuffer,
  hexToRgb,
  parseSubtitleContent,
  type ParsedSubtitleScript,
} from '../lib/subtitleParser';
import { getStreamProxyUrl } from '../lib/apiClient';
import { SubtitleCanvasRenderer } from '../lib/subtitleCanvas';
import { MediaPoster } from './MediaPoster';

interface AnimePlayerProps {
  title: string;
  streams: StreamQuality[];
  referer: string;
  preferDirect?: boolean;
  poster?: string;
  subtitles: SubtitleTrack[];
  onToast: (message: string) => void;
}

interface PersistedPlayerPrefs {
  volume: number;
  muted: boolean;
  capScale: number;
  capColor: string;
}

interface HlsQualityLevel {
  index: number; // -1 for Auto
  label: string;
  height: number;
}

interface LoadedSubtitleEntry {
  id: string;
  label: string;
  url?: string;
  script?: ParsedSubtitleScript;
  isLocal?: boolean;
}

type SettingsTab = 'main' | 'quality' | 'speed' | 'subs';

const PREFS_KEY = 'topanimes:player:v1';
const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const COLOR_PRESETS = ['#ffff00', '#ffffff', '#00ffff', '#7cfc00', '#ff7ad9', '#ffa500'];
const FRAME_STEP = 1 / 23.976;

function loadPrefs(): PersistedPlayerPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { volume: 1, muted: false, capScale: 1, capColor: '#ffff00' };
    const parsed = JSON.parse(raw) as Partial<PersistedPlayerPrefs>;
    return {
      volume: typeof parsed.volume === 'number' ? Math.max(0, Math.min(1, parsed.volume)) : 1,
      muted: Boolean(parsed.muted),
      capScale: typeof parsed.capScale === 'number' ? Math.max(0.5, Math.min(2, parsed.capScale)) : 1,
      capColor: typeof parsed.capColor === 'string' && hexToRgb(parsed.capColor) ? parsed.capColor : '#ffff00',
    };
  } catch {
    return { volume: 1, muted: false, capScale: 1, capColor: '#ffff00' };
  }
}

function savePrefs(prefs: PersistedPlayerPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage failures
  }
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function AnimePlayer({
  title,
  streams,
  referer,
  preferDirect = false,
  poster,
  subtitles,
  onToast,
}: AnimePlayerProps) {
  const initialPrefs = useMemo(() => loadPrefs(), []);

  // Sort streams by highest height first so highest quality is auto-selected
  const sortedStreams = useMemo(() => {
    return [...streams].sort((a, b) => (b.height || 0) - (a.height || 0));
  }, [streams]);

  const [selectedStreamIdx, setSelectedStreamIdx] = useState(0);
  const activeStream = sortedStreams[selectedStreamIdx] || sortedStreams[0] || null;

  type PlaybackMode = 'direct-cors' | 'proxy' | 'direct-nocors';
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(
    preferDirect ? 'direct-cors' : 'proxy'
  );
  const [retryToken, setRetryToken] = useState(0);

  const proxiedStreamUrl = useMemo(() => {
    if (!activeStream) return '';
    return getStreamProxyUrl(activeStream.url, referer || 'https://topanimes.net/');
  }, [activeStream, referer]);

  const activeMediaUrl = useMemo(() => {
    if (!activeStream) return '';
    return playbackMode === 'proxy' ? proxiedStreamUrl : activeStream.url;
  }, [activeStream, playbackMode, proxiedStreamUrl]);

  const useCorsAttr = playbackMode !== 'direct-nocors';

  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<SubtitleCanvasRenderer | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdActiveRef = useRef(false);
  const preHoldSpeedRef = useRef(1);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' | 'center' }>({
    time: 0,
    side: 'center',
  });

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [hasVideoFrame, setHasVideoFrame] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(initialPrefs.volume);
  const [muted, setMuted] = useState(initialPrefs.muted);
  const [speed, setSpeed] = useState(1);
  const [holdSpeedActive, setHoldSpeedActive] = useState(false);
  const [loop, setLoop] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [seekBadge, setSeekBadge] = useState<{ label: string; key: number } | null>(null);
  const [hoverSeek, setHoverSeek] = useState<{ pct: number; time: number } | null>(null);

  // Quality levels inside HLS
  const [hlsLevels, setHlsLevels] = useState<HlsQualityLevel[]>([]);
  const [activeHlsLevel, setActiveHlsLevel] = useState<number>(-1);

  // Settings menu
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuTab, setMenuTab] = useState<SettingsTab>('main');

  // Subtitles state (ported from userscript)
  const [subEntries, setSubEntries] = useState<LoadedSubtitleEntry[]>([]);
  const [activeSubId, setActiveSubId] = useState<string>('off');
  const [activeSubScript, setActiveSubScript] = useState<ParsedSubtitleScript | null>(null);
  const [capDelay, setCapDelay] = useState(0);
  const [capScale, setCapScale] = useState(initialPrefs.capScale);
  const [capColor, setCapColor] = useState(initialPrefs.capColor);
  const subScriptCacheRef = useRef<Map<string, ParsedSubtitleScript>>(new Map());

  // Persist user prefs
  useEffect(() => {
    savePrefs({ volume, muted, capScale, capColor });
  }, [volume, muted, capScale, capColor]);

  // Reset stream index when stream list changes (pick highest quality index 0)
  useEffect(() => {
    setSelectedStreamIdx(0);
  }, [streams]);

  // Reset playback mode whenever stream or preferDirect changes
  useEffect(() => {
    setPlaybackMode(preferDirect ? 'direct-cors' : 'proxy');
  }, [activeStream?.url, preferDirect]);

  // Reset speed per video just like the userscript
  useEffect(() => {
    setSpeed(1);
    setHasVideoFrame(false);
    setErrorMsg('');
    setPlaying(false);
    setWaiting(false);
    if (videoRef.current) {
      videoRef.current.playbackRate = 1;
    }
  }, [activeStream?.url, retryToken]);

  // Sync incoming remote subtitle tracks
  useEffect(() => {
    const entries: LoadedSubtitleEntry[] = subtitles.map((s, idx) => ({
      id: `remote-${idx}-${s.url}`,
      label: s.label,
      url: s.url,
    }));
    setSubEntries(entries);
    const def = subtitles.findIndex((s) => s.isDefault);
    if (entries.length > 0) {
      const target = def >= 0 ? entries[def] : entries[0];
      setActiveSubId(target.id);
    } else {
      setActiveSubId('off');
      setActiveSubScript(null);
    }
  }, [subtitles]);

  // Fetch & parse active subtitle track
  useEffect(() => {
    if (activeSubId === 'off') {
      setActiveSubScript(null);
      return;
    }

    const entry = subEntries.find((s) => s.id === activeSubId);
    if (!entry) {
      setActiveSubScript(null);
      return;
    }

    if (entry.script) {
      setActiveSubScript(entry.script);
      return;
    }

    const cached = subScriptCacheRef.current.get(entry.id);
    if (cached) {
      setActiveSubScript(cached);
      return;
    }

    if (!entry.url) return;

    let cancelled = false;
    const subProxyUrl = getStreamProxyUrl(entry.url, referer || 'https://topanimes.net/');

    fetch(subProxyUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const decoded = decodeSubtitleBuffer(buf);
        const rgb = hexToRgb(capColor) || [255, 255, 0];
        const parsed = parseSubtitleContent(decoded, rgb);
        if (parsed) {
          subScriptCacheRef.current.set(entry.id, parsed);
          setActiveSubScript(parsed);
        } else {
          onToast('Legenda vazia ou em formato não reconhecido.');
        }
      })
      .catch(() => {
        if (!cancelled) onToast('Não foi possível carregar o arquivo de legenda.');
      });

    return () => {
      cancelled = true;
    };
  }, [activeSubId, subEntries, referer, capColor, onToast]);

  const advanceFallbackOrFail = useCallback(() => {
    if (!activeStream) return;
    if (playbackMode === 'direct-cors') {
      setPlaybackMode('proxy');
      return;
    }
    const isHlsStream =
      activeStream.format === 'hls' || /\.m3u8(?:$|\?)/i.test(activeStream.url);
    const requiresProxyHeaders = /googlevideo\.com|incvideo1\.|filevideo1\.|b-cdn\.net/i.test(
      activeStream.url
    );
    if (playbackMode === 'proxy' && !isHlsStream && !requiresProxyHeaders) {
      setPlaybackMode('direct-nocors');
      return;
    }
    setPlaying(false);
    setWaiting(false);
    setErrorMsg(
      'Não foi possível reproduzir este servidor. Tente novamente ou escolha outro servidor abaixo.'
    );
  }, [activeStream, playbackMode]);

  const disposedEffectRef = useRef(false);

  // Initialize Video + HLS
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeMediaUrl || !activeStream) return;

    let disposed = false;
    disposedEffectRef.current = false;
    setErrorMsg('');
    setHlsLevels([]);
    setActiveHlsLevel(-1);

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const useHls =
      activeStream.format === 'hls' || /\.m3u8(?:$|\?)/i.test(activeStream.url);

    video.volume = volume;
    video.muted = muted;
    video.loop = loop;
    video.playbackRate = 1;
    if (useCorsAttr) {
      video.crossOrigin = 'anonymous';
    } else {
      video.removeAttribute('crossorigin');
    }

    if (useHls && Hls.isSupported()) {
      let networkRetries = 0;
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        startLevel: -1,
      });
      hlsRef.current = hls;
      hls.loadSource(activeMediaUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (disposed) return;
        if (data.levels && data.levels.length > 0) {
          const lvls: HlsQualityLevel[] = data.levels
            .map((lvl, index) => ({
              index,
              height: lvl.height || 0,
              label: lvl.height ? `${lvl.height}p` : `Nível ${index + 1}`,
            }))
            .sort((a, b) => b.height - a.height);
          setHlsLevels(lvls);
          // Userscript behavior: auto-select highest quality by default
          const highest = lvls[0];
          if (highest && lvls.length > 1) {
            hls.currentLevel = highest.index;
            setActiveHlsLevel(highest.index);
          } else {
            setActiveHlsLevel(-1);
          }
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 1) {
          networkRetries += 1;
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        hls.destroy();
        if (hlsRef.current === hls) hlsRef.current = null;
        advanceFallbackOrFail();
      });

      return () => {
        disposed = true;
        disposedEffectRef.current = true;
        hls.destroy();
        if (hlsRef.current === hls) hlsRef.current = null;
      };
    }

    video.src = activeMediaUrl;
    return () => {
      disposed = true;
      disposedEffectRef.current = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [activeMediaUrl, activeStream, useCorsAttr, retryToken, advanceFallbackOrFail]);

  // Keep video properties synced
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.loop = loop;
  }, [loop]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  // Subtitle canvas render loop (rAF + ResizeObserver)
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!canvas || !video || !stage) return;

    if (!rendererRef.current) {
      rendererRef.current = new SubtitleCanvasRenderer(canvas);
    }
    const renderer = rendererRef.current;

    let rafId = 0;
    const rgb = hexToRgb(capColor) || [255, 255, 0];

    const drawOnce = () => {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      renderer.render(
        activeSubId === 'off' ? null : activeSubScript,
        video.currentTime,
        rect.width,
        rect.height,
        video.videoWidth,
        video.videoHeight,
        window.devicePixelRatio || 1,
        {
          delay: capDelay,
          scale: capScale,
          colorRgb: rgb,
        }
      );
    };

    const tick = () => {
      drawOnce();
      if (!video.paused && !video.ended) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const onSync = () => {
      window.cancelAnimationFrame(rafId);
      drawOnce();
      if (!video.paused && !video.ended) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const ro = new ResizeObserver(() => drawOnce());
    ro.observe(stage);

    video.addEventListener('play', onSync);
    video.addEventListener('pause', onSync);
    video.addEventListener('seeked', onSync);
    video.addEventListener('timeupdate', drawOnce);
    video.addEventListener('loadedmetadata', drawOnce);

    drawOnce();
    if (!video.paused && !video.ended) {
      rafId = window.requestAnimationFrame(tick);
    }

    return () => {
      window.cancelAnimationFrame(rafId);
      ro.disconnect();
      video.removeEventListener('play', onSync);
      video.removeEventListener('pause', onSync);
      video.removeEventListener('seeked', onSync);
      video.removeEventListener('timeupdate', drawOnce);
      video.removeEventListener('loadedmetadata', drawOnce);
    };
  }, [activeSubScript, activeSubId, capDelay, capScale, capColor]);

  // Track fullscreen changes + try orientation unlock
  useEffect(() => {
    const onFsChange = () => {
      const fs = Boolean(document.fullscreenElement);
      setIsFullscreen(fs);
      if (!fs) {
        try {
          (screen.orientation as ScreenOrientation & { unlock?: () => void })?.unlock?.();
        } catch {
          // ignore
        }
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const showControlsTemporarily = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (videoRef.current && !videoRef.current.paused && !menuOpen) {
      hideTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
      }, 2800);
    }
  }, [menuOpen]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      video.play().catch(() => {
        onToast('Toque novamente para iniciar a reprodução.');
      });
    } else {
      video.pause();
    }
    showControlsTemporarily();
  }, [onToast, showControlsTemporarily]);

  const seekBy = useCallback(
    (deltaSeconds: number, label?: string) => {
      const video = videoRef.current;
      if (!video) return;
      const cap = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number.MAX_SAFE_INTEGER;
      const next = Math.max(0, Math.min(cap, video.currentTime + deltaSeconds));
      video.currentTime = next;
      setCurrentTime(next);
      const text =
        label ||
        `${deltaSeconds > 0 ? '+' : ''}${Math.round(deltaSeconds)}s`;
      setSeekBadge({ label: text, key: Date.now() });
      showControlsTemporarily();
    },
    [showControlsTemporarily]
  );

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      if (!next && volume === 0) setVolume(0.5);
      return next;
    });
    showControlsTemporarily();
  }, [volume, showControlsTemporarily]);

  const toggleFullscreen = useCallback(async () => {
    const stage = stageRef.current;
    const video = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null;
    if (!stage) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (stage.requestFullscreen) {
        await stage.requestFullscreen();
        try {
          const orientation = screen.orientation as ScreenOrientation & {
            lock?: (o: string) => Promise<void>;
          };
          await orientation?.lock?.('landscape');
        } catch {
          // Many browsers restrict orientation lock; safe to ignore
        }
        return;
      }
    } catch {
      // Fallback for iOS Safari
    }
    if (video?.webkitEnterFullscreen) {
      try {
        video.webkitEnterFullscreen();
      } catch {
        // ignore
      }
    }
  }, []);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
      } else {
        onToast('Picture-in-Picture não é suportado neste navegador.');
      }
    } catch {
      onToast('Não foi possível ativar Picture-in-Picture agora.');
    }
  }, [onToast]);

  const captureFramePng = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      onToast('Inicie o vídeo antes de capturar um quadro.');
      return;
    }
    try {
      const snap = document.createElement('canvas');
      snap.width = video.videoWidth;
      snap.height = video.videoHeight;
      const ctx = snap.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, snap.width, snap.height);
      const dataUrl = snap.toDataURL('image/png');
      const a = document.createElement('a');
      const cleanName = title.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 48) || 'frame';
      a.href = dataUrl;
      a.download = `${cleanName}_${Math.floor(video.currentTime)}s.png`;
      a.click();
      onToast('Quadro salvo em PNG.');
    } catch {
      onToast('Não foi possível capturar o quadro neste servidor.');
    }
  }, [onToast, title]);

  const handleDownloadVideo = useCallback(async () => {
    if (!activeStream) return;
    if (activeStream.format === 'hls') {
      try {
        await navigator.clipboard.writeText(activeStream.url);
        onToast('Link HLS (.m3u8) copiado para a área de transferência.');
      } catch {
        onToast('Streams HLS usam o link direto para download externo.');
      }
      return;
    }
    const a = document.createElement('a');
    a.href = preferDirect ? activeStream.url : `${proxiedStreamUrl}&download=1`;
    if (preferDirect) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    const cleanName = title.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 48) || 'episodio';
    a.download = `${cleanName}.mp4`;
    a.click();
    onToast('Iniciando download do vídeo MP4...');
  }, [activeStream, onToast, preferDirect, proxiedStreamUrl, title]);

  const loadLocalSubtitleFile = useCallback(
    async (file: File) => {
      if (!/\.(srt|vtt|ass|ssa)$/i.test(file.name)) {
        onToast('Envie um arquivo de legenda .srt, .vtt, .ass ou .ssa.');
        return;
      }
      try {
        const buf = await file.arrayBuffer();
        const decoded = decodeSubtitleBuffer(buf);
        const rgb = hexToRgb(capColor) || [255, 255, 0];
        const parsed = parseSubtitleContent(decoded, rgb);
        if (!parsed) {
          onToast('Nenhuma fala encontrada no arquivo de legenda.');
          return;
        }
        const id = `local-${Date.now()}-${file.name}`;
        setSubEntries((prev) => [
          ...prev,
          { id, label: `Local: ${file.name}`, script: parsed, isLocal: true },
        ]);
        setActiveSubId(id);
        setActiveSubScript(parsed);
        onToast(`Legenda carregada: ${file.name}`);
      } catch {
        onToast('Falha ao ler o arquivo de legenda.');
      }
    },
    [capColor, onToast]
  );

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadLocalSubtitleFile(file);
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadLocalSubtitleFile(file);
  };

  // Hold-to-2x pointer handlers on the video stage
  const startHoldSpeed = () => {
    if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    holdActiveRef.current = false;
    holdTimerRef.current = window.setTimeout(() => {
      holdActiveRef.current = true;
      preHoldSpeedRef.current = speed;
      setHoldSpeedActive(true);
      if (videoRef.current) videoRef.current.playbackRate = 2;
    }, 450);
  };

  const cancelHoldSpeed = () => {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdActiveRef.current) {
      holdActiveRef.current = false;
      setHoldSpeedActive(false);
      if (videoRef.current) videoRef.current.playbackRate = preHoldSpeedRef.current;
    }
  };

  const handleStageTap = (clientX: number) => {
    if (holdActiveRef.current) {
      cancelHoldSpeed();
      return;
    }
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const relX = (clientX - rect.left) / Math.max(1, rect.width);
    const side: 'left' | 'right' | 'center' =
      relX < 0.3 ? 'left' : relX > 0.7 ? 'right' : 'center';

    const now = Date.now();
    if (
      side !== 'center' &&
      lastTapRef.current.side === side &&
      now - lastTapRef.current.time < 320
    ) {
      seekBy(side === 'left' ? -5 : 5);
      lastTapRef.current = { time: 0, side: 'center' };
      return;
    }

    lastTapRef.current = { time: now, side };
    if (side === 'center') {
      togglePlay();
    } else {
      showControlsTemporarily();
    }
  };

  // Desktop keyboard shortcuts from userscript
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const video = videoRef.current;
      if (!video) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) {
          startHoldSpeed();
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'arrowleft':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            video.pause();
            seekBy(-FRAME_STEP, '-1 quadro');
          } else if (e.altKey) {
            seekBy(-60, '-1m');
          } else {
            seekBy(-5);
          }
          break;
        case 'arrowright':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            video.pause();
            seekBy(FRAME_STEP, '+1 quadro');
          } else if (e.altKey) {
            seekBy(60, '+1m');
          } else {
            seekBy(5);
          }
          break;
        case 'arrowup':
          e.preventDefault();
          setMuted(false);
          setVolume((v) => Math.min(1, Number((v + 0.05).toFixed(2))));
          showControlsTemporarily();
          break;
        case 'arrowdown':
          e.preventDefault();
          setVolume((v) => Math.max(0, Number((v - 0.05).toFixed(2))));
          showControlsTemporarily();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'c':
          e.preventDefault();
          setActiveSubId((prev) => {
            if (prev !== 'off') return 'off';
            return subEntries[0]?.id || 'off';
          });
          showControlsTemporarily();
          break;
        default:
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault();
        const wasHold = holdActiveRef.current;
        cancelHoldSpeed();
        if (!wasHold) {
          togglePlay();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [seekBy, showControlsTemporarily, subEntries, toggleFullscreen, toggleMute, togglePlay]);

  // Clear transient seek ripple badge
  useEffect(() => {
    if (!seekBadge) return;
    const t = window.setTimeout(() => setSeekBadge(null), 650);
    return () => window.clearTimeout(t);
  }, [seekBadge]);

  const activeQualityLabel = useMemo(() => {
    if (activeHlsLevel >= 0) {
      return hlsLevels.find((l) => l.index === activeHlsLevel)?.label || 'HLS';
    }
    return activeStream?.label || 'Auto';
  }, [activeHlsLevel, activeStream, hlsLevels]);

  const activeSubLabel = useMemo(() => {
    if (activeSubId === 'off') return 'Desativadas';
    return subEntries.find((s) => s.id === activeSubId)?.label || 'Ativa';
  }, [activeSubId, subEntries]);

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, (bufferedEnd / duration) * 100) : 0;

  return (
    <div
      ref={stageRef}
      onMouseMove={showControlsTemporarily}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`group relative aspect-video w-full select-none overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl ${
        isFullscreen ? 'rounded-none border-0' : ''
      }`}
    >
      {/* Visual backdrop poster behind video so video element stays CORS-clean */}
      {poster && !hasVideoFrame && (
        <div className="pointer-events-none absolute inset-0">
          <MediaPoster src={poster} alt={title} aspect="landscape" className="h-full w-full opacity-55" />
        </div>
      )}

      {/* HTML5 Video (direct CDN when CORS-ready, or /api/stream-proxy with 4MB chunked range) */}
      <video
        ref={videoRef}
        playsInline
        preload="metadata"
        crossOrigin={useCorsAttr ? 'anonymous' : undefined}
        className="h-full w-full object-contain"
        onPlay={() => {
          setPlaying(true);
          showControlsTemporarily();
        }}
        onPause={() => {
          setPlaying(false);
          setControlsVisible(true);
        }}
        onEnded={() => {
          setPlaying(false);
          setControlsVisible(true);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => {
          setWaiting(false);
          setHasVideoFrame(true);
          setErrorMsg('');
        }}
        onLoadedData={() => setHasVideoFrame(true)}
        onTimeUpdate={() => {
          const v = videoRef.current;
          if (!v) return;
          setCurrentTime(v.currentTime);
          if (v.buffered.length > 0) {
            setBufferedEnd(v.buffered.end(v.buffered.length - 1));
          }
        }}
        onDurationChange={() => {
          if (videoRef.current && Number.isFinite(videoRef.current.duration)) {
            setDuration(videoRef.current.duration);
          }
        }}
        onError={() => {
          const v = videoRef.current;
          if (disposedEffectRef.current || !v || !v.getAttribute('src') || !v.error) return;
          if (hlsRef.current) return; // Hls.js handles its own fatal fallback
          advanceFallbackOrFail();
        }}
      />

      {/* Canvas Subtitle Overlay */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-10 h-full w-full"
      />

      {/* Interactive Gesture Surface (Tap, Double-Tap Seek, Hold 2x) */}
      <div
        className="absolute inset-0 z-20"
        onPointerDown={() => startHoldSpeed()}
        onPointerUp={(e) => handleStageTap(e.clientX)}
        onPointerCancel={cancelHoldSpeed}
        onPointerLeave={cancelHoldSpeed}
      />

      {/* Hidden local subtitle file picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.vtt,.ass,.ssa"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Hold 2x Speed Indicator */}
      {holdSpeedActive && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/75 px-3.5 py-1.5 text-xs font-semibold text-white backdrop-blur-sm">
          <FastForward className="h-3.5 w-3.5 text-[#f97316]" />
          <span>2× Velocidade</span>
        </div>
      )}

      {/* Seek Ripple Feedback */}
      {seekBadge && (
        <div
          key={seekBadge.key}
          className="pointer-events-none absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/75 px-4 py-2 font-mono text-sm font-semibold tabular-nums text-white backdrop-blur-sm"
        >
          {seekBadge.label}
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-[#f97316] bg-[#0d0f12]/80">
          <div className="flex items-center gap-2 rounded-xl bg-[#151921] px-4 py-2.5 text-sm font-medium text-white">
            <Upload className="h-4 w-4 text-[#f97316]" />
            <span>Solte a legenda (.srt, .vtt, .ass, .ssa)</span>
          </div>
        </div>
      )}

      {/* Buffering Spinner */}
      {waiting && !errorMsg && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <div className="h-11 w-11 animate-spin rounded-full border-3 border-white/25 border-t-[#f97316]" />
        </div>
      )}

      {/* Center Play Button when Paused */}
      {!playing && !errorMsg && !waiting && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Reproduzir episódio"
          className="absolute left-1/2 top-1/2 z-30 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#f97316] text-[#0d0f12] shadow-2xl transition-transform hover:scale-105 active:scale-95 sm:h-[72px] sm:w-[72px]"
        >
          <Play className="ml-1 h-7 w-7 fill-current sm:h-8 sm:w-8" />
        </button>
      )}

      {/* Playback Error State */}
      {errorMsg && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center">
          <p className="max-w-md text-sm text-red-200">{errorMsg}</p>
          <button
            type="button"
            onClick={() => {
              setErrorMsg('');
              setPlaybackMode(preferDirect ? 'direct-cors' : 'proxy');
              setRetryToken((n) => n + 1);
            }}
            className="rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c]"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* Bottom Controls HUD */}
      <div
        className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/65 to-transparent px-3 pb-2.5 pt-10 transition-opacity duration-200 sm:px-4 sm:pb-3 ${
          controlsVisible || !playing || menuOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Seek Bar */}
        <div
          className="relative mb-2.5 flex h-5 cursor-pointer items-center"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setHoverSeek({ pct: pct * 100, time: pct * (duration || 0) });
          }}
          onMouseLeave={() => setHoverSeek(null)}
        >
          {hoverSeek && duration > 0 && (
            <div
              className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/90 px-2 py-0.5 font-mono text-[11px] tabular-nums text-white"
              style={{ left: `${hoverSeek.pct}%` }}
            >
              {formatTime(hoverSeek.time)}
            </div>
          )}
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/20">
            <div
              className="absolute inset-y-0 left-0 bg-white/35"
              style={{ width: `${bufferedPct}%` }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-[#f97316]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <input
            type="range"
            aria-label="Progresso do vídeo"
            min={0}
            max={duration || 100}
            step={0.1}
            value={Math.min(currentTime, duration || 100)}
            onChange={(e) => {
              const target = Number(e.target.value);
              if (videoRef.current) videoRef.current.currentTime = target;
              setCurrentTime(target);
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>

        {/* Control Buttons Row */}
        <div className="flex items-center justify-between gap-1 sm:gap-2">
          {/* Left Side: Play, Audio, Time, -5s, +5s, +85s */}
          <div className="flex min-w-0 items-center gap-0.5 sm:gap-1.5">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? 'Pausar' : 'Reproduzir'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white hover:bg-white/10 sm:h-9 sm:w-9"
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
            </button>

            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? 'Ativar som' : 'Silenciar'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white hover:bg-white/10 sm:h-9 sm:w-9"
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>

            <input
              type="range"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.02}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                if (v > 0 && muted) setMuted(false);
              }}
              className="hidden h-1 w-16 cursor-pointer accent-[#f97316] md:block"
            />

            <span className="whitespace-nowrap px-1 font-mono text-[11px] tabular-nums text-slate-200 sm:px-1.5 sm:text-xs">
              {formatTime(currentTime)} <span className="text-slate-500">/</span> {formatTime(duration)}
            </span>

            <button
              type="button"
              onClick={() => seekBy(-5)}
              title="Voltar 5 segundos (←)"
              className="hidden h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-200 hover:bg-white/10 sm:inline-flex"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="tabular-nums">-5s</span>
            </button>

            <button
              type="button"
              onClick={() => seekBy(5)}
              title="Avançar 5 segundos (→)"
              className="hidden h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-200 hover:bg-white/10 sm:inline-flex"
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span className="tabular-nums">+5s</span>
            </button>

            <button
              type="button"
              onClick={() => seekBy(85, '+85s Abertura')}
              title="Pular abertura (+85s)"
              className="ml-0.5 inline-flex h-7 shrink-0 items-center rounded-md border border-[#f97316]/40 bg-[#f97316]/15 px-2 font-mono text-[11px] font-semibold tabular-nums text-[#fb923c] hover:bg-[#f97316]/25 sm:h-8 sm:px-2.5 sm:text-xs"
            >
              +85s
            </button>
          </div>

          {/* Right Side: Quality, CC, Settings, PiP, Fullscreen */}
          <div className="relative flex shrink-0 items-center gap-0.5 sm:gap-1">
            <button
              type="button"
              onClick={() => {
                setMenuTab('quality');
                setMenuOpen((o) => (menuTab === 'quality' ? !o : true));
              }}
              className="hidden h-8 items-center rounded-md border border-white/15 bg-white/5 px-2 font-mono text-[11px] font-medium tabular-nums text-slate-200 hover:bg-white/15 sm:inline-flex"
            >
              {activeQualityLabel}
            </button>

            <button
              type="button"
              onClick={() => {
                setMenuTab('subs');
                setMenuOpen((o) => (menuTab === 'subs' ? !o : true));
              }}
              aria-label="Legendas"
              className={`relative flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white/10 sm:h-9 sm:w-9 ${
                activeSubId !== 'off' ? 'text-[#f97316]' : 'text-slate-300'
              }`}
            >
              <Subtitles className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => {
                setMenuTab('main');
                setMenuOpen((o) => !o);
              }}
              aria-label="Configurações do player"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-white hover:bg-white/10 sm:h-9 sm:w-9"
            >
              <Settings className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={togglePip}
              aria-label="Picture-in-Picture"
              className="hidden h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/10 sm:flex"
            >
              <PictureInPicture2 className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-white hover:bg-white/10 sm:h-9 sm:w-9"
            >
              {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>

            {/* Mobile backdrop & Popover/Sheet Settings Menu */}
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40 bg-black/50 sm:hidden"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="fixed inset-x-3 bottom-16 z-50 max-h-[65vh] overflow-y-auto rounded-xl border border-white/15 bg-[#151921]/95 p-2 text-xs text-slate-200 shadow-2xl backdrop-blur-md sm:absolute sm:inset-x-auto sm:bottom-11 sm:right-0 sm:max-h-[75vh] sm:w-72">
                {menuTab === 'main' && (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => setMenuTab('quality')}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/10"
                    >
                      <span>Qualidade</span>
                      <span className="inline-flex items-center gap-1 font-mono text-slate-400">
                        {activeQualityLabel}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setMenuTab('speed')}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/10"
                    >
                      <span>Velocidade</span>
                      <span className="inline-flex items-center gap-1 font-mono tabular-nums text-slate-400">
                        {speed === 1 ? 'Normal' : `${speed}×`}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setMenuTab('subs')}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/10"
                    >
                      <span>Legendas</span>
                      <span className="inline-flex max-w-[130px] items-center gap-1 truncate text-slate-400">
                        <span className="truncate">{activeSubLabel}</span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      </span>
                    </button>

                    <div className="my-1 border-t border-white/10" />

                    <button
                      type="button"
                      onClick={() => setLoop((v) => !v)}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/10"
                    >
                      <span className="inline-flex items-center gap-2">
                        <Repeat className="h-3.5 w-3.5 text-slate-400" />
                        Repetir vídeo
                      </span>
                      <span className={loop ? 'font-semibold text-[#f97316]' : 'text-slate-500'}>
                        {loop ? 'Ligado' : 'Desligado'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        captureFramePng();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10"
                    >
                      <Camera className="h-3.5 w-3.5 text-slate-400" />
                      <span>Salvar quadro (PNG)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        handleDownloadVideo();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10"
                    >
                      <Download className="h-3.5 w-3.5 text-slate-400" />
                      <span>
                        {activeStream?.format === 'hls'
                          ? 'Copiar URL do stream (.m3u8)'
                          : 'Baixar vídeo (MP4)'}
                      </span>
                    </button>
                  </div>
                )}

                {menuTab === 'quality' && (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => setMenuTab('main')}
                      className="mb-1 flex w-full items-center gap-1.5 border-b border-white/10 px-2 pb-2 font-semibold text-white"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      <span>Qualidade</span>
                    </button>

                    {hlsLevels.length > 0 ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            if (hlsRef.current) hlsRef.current.currentLevel = -1;
                            setActiveHlsLevel(-1);
                            setMenuOpen(false);
                          }}
                          className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/10"
                        >
                          <span>Automático</span>
                          {activeHlsLevel === -1 && <Check className="h-3.5 w-3.5 text-[#f97316]" />}
                        </button>
                        {hlsLevels.map((lvl) => (
                          <button
                            key={lvl.index}
                            type="button"
                            onClick={() => {
                              if (hlsRef.current) hlsRef.current.currentLevel = lvl.index;
                              setActiveHlsLevel(lvl.index);
                              setMenuOpen(false);
                            }}
                            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/10"
                          >
                            <span className="font-mono">{lvl.label}</span>
                            {activeHlsLevel === lvl.index && (
                              <Check className="h-3.5 w-3.5 text-[#f97316]" />
                            )}
                          </button>
                        ))}
                      </>
                    ) : (
                      sortedStreams.map((stream, idx) => (
                        <button
                          key={stream.url}
                          type="button"
                          onClick={() => {
                            setSelectedStreamIdx(idx);
                            setMenuOpen(false);
                          }}
                          className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/10"
                        >
                          <span className="font-mono">{stream.label}</span>
                          {selectedStreamIdx === idx && (
                            <Check className="h-3.5 w-3.5 text-[#f97316]" />
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}

                {menuTab === 'speed' && (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => setMenuTab('main')}
                      className="mb-1 flex w-full items-center gap-1.5 border-b border-white/10 px-2 pb-2 font-semibold text-white"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      <span>Velocidade</span>
                    </button>
                    <div className="grid grid-cols-3 gap-1 p-1">
                      {SPEED_OPTIONS.map((sp) => (
                        <button
                          key={sp}
                          type="button"
                          onClick={() => {
                            setSpeed(sp);
                            setMenuOpen(false);
                          }}
                          className={`rounded-md py-1.5 font-mono tabular-nums transition-colors ${
                            speed === sp
                              ? 'bg-[#f97316] font-semibold text-[#0d0f12]'
                              : 'bg-white/5 text-slate-300 hover:bg-white/15'
                          }`}
                        >
                          {sp === 1 ? '1×' : `${sp}×`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {menuTab === 'subs' && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setMenuTab('main')}
                      className="flex w-full items-center gap-1.5 border-b border-white/10 px-2 pb-2 font-semibold text-white"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      <span>Legendas (ASS / SRT / VTT)</span>
                    </button>

                    <div className="max-h-32 space-y-1 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => setActiveSubId('off')}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left hover:bg-white/10"
                      >
                        <span>Desativadas</span>
                        {activeSubId === 'off' && <Check className="h-3.5 w-3.5 text-[#f97316]" />}
                      </button>
                      {subEntries.map((sub) => (
                        <button
                          key={sub.id}
                          type="button"
                          onClick={() => setActiveSubId(sub.id)}
                          className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left hover:bg-white/10"
                        >
                          <span className="truncate">{sub.label}</span>
                          {activeSubId === sub.id && (
                            <Check className="h-3.5 w-3.5 shrink-0 text-[#f97316]" />
                          )}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 bg-[#0d0f12] px-3 py-2 font-medium text-white hover:border-[#f97316]"
                    >
                      <Upload className="h-3.5 w-3.5 text-[#f97316]" />
                      <span>Carregar legenda local</span>
                    </button>

                    <div className="space-y-2 border-t border-white/10 pt-2">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-slate-400">Atraso</span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setCapDelay((d) => Number((d - 0.1).toFixed(1)))}
                            className="rounded bg-white/10 px-2 py-0.5 font-mono text-white hover:bg-white/20"
                          >
                            −0.1s
                          </button>
                          <span className="min-w-[44px] text-center font-mono tabular-nums text-white">
                            {capDelay >= 0 ? `+${capDelay.toFixed(1)}s` : `${capDelay.toFixed(1)}s`}
                          </span>
                          <button
                            type="button"
                            onClick={() => setCapDelay((d) => Number((d + 0.1).toFixed(1)))}
                            className="rounded bg-white/10 px-2 py-0.5 font-mono text-white hover:bg-white/20"
                          >
                            +0.1s
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center justify-between px-1">
                        <span className="text-slate-400">Tamanho</span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setCapScale((s) => Math.max(0.5, Number((s - 0.1).toFixed(2))))
                            }
                            className="rounded bg-white/10 px-2 py-0.5 font-mono text-white hover:bg-white/20"
                          >
                            −
                          </button>
                          <span className="min-w-[44px] text-center font-mono tabular-nums text-white">
                            {Math.round(capScale * 100)}%
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setCapScale((s) => Math.min(2, Number((s + 0.1).toFixed(2))))
                            }
                            className="rounded bg-white/10 px-2 py-0.5 font-mono text-white hover:bg-white/20"
                          >
                            +
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center justify-between px-1">
                        <span className="text-slate-400">Cor (SRT/VTT)</span>
                        <div className="flex items-center gap-1.5">
                          {COLOR_PRESETS.map((hex) => (
                            <button
                              key={hex}
                              type="button"
                              aria-label={`Cor ${hex}`}
                              onClick={() => setCapColor(hex)}
                              className={`h-4 w-4 rounded-full border ${
                                capColor.toLowerCase() === hex
                                  ? 'scale-110 border-white'
                                  : 'border-white/25'
                              }`}
                              style={{ backgroundColor: hex }}
                            />
                          ))}
                          <input
                            type="color"
                            aria-label="Cor personalizada da legenda"
                            value={capColor}
                            onChange={(e) => setCapColor(e.target.value)}
                            className="h-5 w-6 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
