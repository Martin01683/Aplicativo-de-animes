import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Cast,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Server,
  SkipBack,
  SkipForward,
  Square,
  Tv,
  Volume2,
  Wifi,
  X,
} from 'lucide-react';
import type { PlayerOption } from '../lib/types';
import {
  addManualTvCastDevice,
  addTvCastDevicesListener,
  computeCastSeekPositionMs,
  computeCastVolumeLevel,
  discoverTvCastDevicesDetailed,
  formatCastDeliveryLabel,
  formatCastDurationMs,
  formatCastProtocolLabel,
  formatCastStatusLabel,
  isNativeAndroidCastSupported,
  prepareExternalTvCast,
  resolveCastDisplayedPositionMs,
  startNativeTvCast,
  stopTvCastDiscovery,
  tvCastNextEpisode,
  tvCastPause,
  tvCastPlay,
  tvCastPrevEpisode,
  tvCastSeek,
  tvCastSeekBy,
  tvCastSetVolume,
  tvCastStop,
  type TvCastDeliveryPreference,
  type TvCastDevice,
  type TvCastMediaPayload,
  type TvCastStateSnapshot,
} from '../lib/tvCast';

interface TvCastModalProps {
  open: boolean;
  onClose: () => void;
  castState: TvCastStateSnapshot;
  mediaPayload: TvCastMediaPayload | null;
  deliveryPref?: TvCastDeliveryPreference;
  onChangeDeliveryPref?: (pref: TvCastDeliveryPreference) => void;
  serverOptions?: PlayerOption[];
  loadingServers?: boolean;
  activeServerNume?: string;
  switchingServerNume?: string;
  onSelectCastServer?: (opt: PlayerOption, discoveredDevices: TvCastDevice[]) => Promise<void> | void;
  onDeviceConnected?: (device: TvCastDevice) => void;
  onSeekCommitted?: (targetMs: number) => void;
  skipIntroSeconds?: number;
  canPromptWebRemote?: boolean;
  onPromptWebRemote?: () => Promise<void>;
  onPauseLocalPlayback?: () => void;
  onToast: (message: string) => void;
}

export function TvCastModal({
  open,
  onClose,
  castState,
  mediaPayload,
  deliveryPref: controlledDeliveryPref,
  onChangeDeliveryPref,
  serverOptions = [],
  loadingServers = false,
  activeServerNume = '',
  switchingServerNume = '',
  onSelectCastServer,
  onDeviceConnected,
  onSeekCommitted,
  skipIntroSeconds = 85,
  canPromptWebRemote = false,
  onPromptWebRemote,
  onPauseLocalPlayback,
  onToast,
}: TvCastModalProps) {
  const isNativeAndroid = isNativeAndroidCastSupported();
  const [devices, setDevices] = useState<TvCastDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lanDiscoverySupported, setLanDiscoverySupported] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [connectingId, setConnectingId] = useState('');
  const [internalDeliveryPref, setInternalDeliveryPref] =
    useState<TvCastDeliveryPreference>('auto');
  const deliveryPref = controlledDeliveryPref ?? internalDeliveryPref;
  const setDeliveryPref = (nextPref: TvCastDeliveryPreference) => {
    setInternalDeliveryPref(nextPref);
    onChangeDeliveryPref?.(nextPref);
  };
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualPort, setManualPort] = useState('8009');
  const [copiedLink, setCopiedLink] = useState(false);
  const [preparingExternal, setPreparingExternal] = useState(false);

  // Smooth press-hold-drag-release state for TV timeline & volume sliders
  const [scrubPositionMs, setScrubPositionMs] = useState<number | null>(null);
  const [pendingSeek, setPendingSeek] = useState<{
    targetMs: number;
    episodeKey: string;
    expiresAt: number;
  } | null>(null);
  const [dragVolume, setDragVolume] = useState<number | null>(null);
  const [pendingVolume, setPendingVolume] = useState<{ level: number; expiresAt: number } | null>(
    null
  );

  const seekTrackRef = useRef<HTMLDivElement | null>(null);
  const activeSeekPointerIdRef = useRef<number | null>(null);
  const scrubPositionRef = useRef<number | null>(null);

  const volumeTrackRef = useRef<HTMLDivElement | null>(null);
  const activeVolumePointerIdRef = useRef<number | null>(null);
  const dragVolumeRef = useRef<number | null>(null);

  const castEpisodeKey = `${castState.deviceId}|${castState.episodeUrl || castState.streamUrl || castState.episodeTitle}`;

  useEffect(() => {
    if (!open || !castState.active) {
      activeSeekPointerIdRef.current = null;
      scrubPositionRef.current = null;
      activeVolumePointerIdRef.current = null;
      dragVolumeRef.current = null;
      setScrubPositionMs(null);
      setPendingSeek(null);
      setDragVolume(null);
      setPendingVolume(null);
    }
  }, [castState.active, open]);

  useEffect(() => {
    if (!pendingSeek) return;
    if (
      pendingSeek.episodeKey !== castEpisodeKey ||
      Math.abs(castState.positionMs - pendingSeek.targetMs) <= 4000
    ) {
      setPendingSeek(null);
      return;
    }
    const remaining = pendingSeek.expiresAt - Date.now();
    if (remaining <= 0) {
      setPendingSeek(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setPendingSeek((cur) => (cur && cur.expiresAt <= Date.now() ? null : cur));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [castEpisodeKey, castState.positionMs, pendingSeek]);

  useEffect(() => {
    if (!pendingVolume) return;
    if (Math.abs(castState.volume - pendingVolume.level) <= 0.06) {
      setPendingVolume(null);
      return;
    }
    const remaining = pendingVolume.expiresAt - Date.now();
    if (remaining <= 0) {
      setPendingVolume(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setPendingVolume((cur) => (cur && cur.expiresAt <= Date.now() ? null : cur));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [castState.volume, pendingVolume]);

  const canAutoDiscover = isNativeAndroid || lanDiscoverySupported;

  const runDiscovery = useCallback(async () => {
    setScanning(true);
    setDiscoveryError('');
    try {
      const res = await discoverTvCastDevicesDetailed(isNativeAndroid ? 5500 : 3800);
      setLanDiscoverySupported(isNativeAndroid || res.supported);
      setDevices(res.devices);
      if (res.error) {
        setDiscoveryError(res.error);
      }
    } catch {
      setDiscoveryError('Não foi possível buscar TVs na rede Wi-Fi.');
      onToast('Não foi possível buscar TVs na rede Wi-Fi.');
    } finally {
      setScanning(false);
    }
  }, [isNativeAndroid, onToast]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let listenerHandle: { remove: () => Promise<void> } | null = null;

    if (isNativeAndroid) {
      void addTvCastDevicesListener((ev) => {
        if (!active) return;
        setDevices(ev.devices);
        setScanning(ev.scanning);
      }).then((h) => {
        if (!active) {
          void h?.remove();
        } else {
          listenerHandle = h;
        }
      });
    }

    void runDiscovery();

    return () => {
      active = false;
      void stopTvCastDiscovery();
      void listenerHandle?.remove();
    };
  }, [isNativeAndroid, open, runDiscovery]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  if (!open) return null;

  const isPlayingOrBuffering =
    castState.status === 'playing' || castState.status === 'buffering' || castState.status === 'connecting';

  const seekMaxMs = Math.max(castState.durationMs, castState.positionMs, 1000);
  const displayedPositionMs = resolveCastDisplayedPositionMs({
    livePositionMs: castState.positionMs,
    durationMs: seekMaxMs,
    scrubPositionMs,
    pendingSeekMs: pendingSeek && pendingSeek.episodeKey === castEpisodeKey ? pendingSeek.targetMs : null,
  });
  const isScrubbing = scrubPositionMs !== null;
  const seekProgressPct = Math.max(0, Math.min(100, (displayedPositionMs / seekMaxMs) * 100));
  const previewBubblePct = Math.max(8, Math.min(92, seekProgressPct));

  const displayedVolume =
    dragVolume !== null
      ? dragVolume
      : pendingVolume !== null
        ? pendingVolume.level
        : castState.volume;
  const isDraggingVolume = dragVolume !== null;
  const volumePct = Math.max(0, Math.min(100, displayedVolume * 100));

  const commitSeekPosition = (targetMs: number) => {
    const clamped = Math.max(0, Math.min(seekMaxMs, Math.round(targetMs)));
    onSeekCommitted?.(clamped);
    setPendingSeek({
      targetMs: clamped,
      episodeKey: castEpisodeKey,
      expiresAt: Date.now() + 2500,
    });
    void tvCastSeek(clamped);
  };

  const handleRelativeSeek = (deltaMs: number) => {
    if (castState.durationMs > 0 || displayedPositionMs > 0) {
      commitSeekPosition(displayedPositionMs + deltaMs);
    } else {
      setPendingSeek(null);
      void tvCastSeekBy(deltaMs);
    }
  };

  const updateScrubFromClientX = (clientX: number): number => {
    const el = seekTrackRef.current;
    if (!el) return displayedPositionMs;
    const rect = el.getBoundingClientRect();
    const nextMs = computeCastSeekPositionMs(clientX, rect.left, rect.width, seekMaxMs);
    scrubPositionRef.current = nextMs;
    setScrubPositionMs(nextMs);
    return nextMs;
  };

  const handleSeekPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    activeSeekPointerIdRef.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture is unsupported
    }
    updateScrubFromClientX(e.clientX);
  };

  const handleSeekPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activeSeekPointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    updateScrubFromClientX(e.clientX);
  };

  const handleSeekPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activeSeekPointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    activeSeekPointerIdRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    const el = seekTrackRef.current;
    const finalMs = el
      ? computeCastSeekPositionMs(
          e.clientX,
          el.getBoundingClientRect().left,
          el.getBoundingClientRect().width,
          seekMaxMs
        )
      : (scrubPositionRef.current ?? displayedPositionMs);
    scrubPositionRef.current = null;
    setScrubPositionMs(null);
    commitSeekPosition(finalMs);
  };

  const handleSeekPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activeSeekPointerIdRef.current !== e.pointerId) return;
    activeSeekPointerIdRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    scrubPositionRef.current = null;
    setScrubPositionMs(null);
  };

  const handleSeekKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      commitSeekPosition(displayedPositionMs + 5000);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      commitSeekPosition(displayedPositionMs - 5000);
    } else if (e.key === 'Home') {
      e.preventDefault();
      commitSeekPosition(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      commitSeekPosition(seekMaxMs);
    }
  };

  const commitVolumeLevel = (level: number) => {
    const clamped = Math.max(0, Math.min(1, level));
    setPendingVolume({ level: clamped, expiresAt: Date.now() + 2500 });
    void tvCastSetVolume(clamped);
  };

  const updateVolumeFromClientX = (clientX: number): number => {
    const el = volumeTrackRef.current;
    if (!el) return displayedVolume;
    const rect = el.getBoundingClientRect();
    const nextVol = computeCastVolumeLevel(clientX, rect.left, rect.width);
    dragVolumeRef.current = nextVol;
    setDragVolume(nextVol);
    return nextVol;
  };

  const handleVolumePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    activeVolumePointerIdRef.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    updateVolumeFromClientX(e.clientX);
  };

  const handleVolumePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activeVolumePointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    updateVolumeFromClientX(e.clientX);
  };

  const handleVolumePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activeVolumePointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    activeVolumePointerIdRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    const el = volumeTrackRef.current;
    const finalVol = el
      ? computeCastVolumeLevel(
          e.clientX,
          el.getBoundingClientRect().left,
          el.getBoundingClientRect().width
        )
      : (dragVolumeRef.current ?? displayedVolume);
    dragVolumeRef.current = null;
    setDragVolume(null);
    commitVolumeLevel(finalVol);
  };

  const handleVolumePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activeVolumePointerIdRef.current !== e.pointerId) return;
    activeVolumePointerIdRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    dragVolumeRef.current = null;
    setDragVolume(null);
  };

  const handleVolumeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      commitVolumeLevel(displayedVolume + 0.05);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      commitVolumeLevel(displayedVolume - 0.05);
    }
  };

  const handleSelectDevice = async (device: TvCastDevice) => {
    if (!mediaPayload) {
      onToast('Carregue o episódio antes de transmitir para a TV.');
      return;
    }
    setConnectingId(device.id);
    try {
      onPauseLocalPlayback?.();
      await startNativeTvCast(device, mediaPayload, deliveryPref);
      onDeviceConnected?.(device);
      onToast(
        isNativeAndroid
          ? `Transmitindo em ${device.name} — você pode sair do app.`
          : `Transmitindo em ${device.name} — você pode fechar esta aba ou navegar livremente.`
      );
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : `Não foi possível iniciar a transmissão em ${device.name}.`;
      onToast(msg);
    } finally {
      setConnectingId('');
    }
  };

  const handleAddManual = async () => {
    const cleanHost = manualHost.trim();
    if (!cleanHost) {
      onToast('Informe o IP da TV na rede Wi-Fi (ex.: 192.168.1.50).');
      return;
    }
    const parsedPort = Number.parseInt(manualPort.trim(), 10);
    try {
      const device = await addManualTvCastDevice({
        host: cleanHost,
        port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8009,
        name: manualName.trim() || `TV (${cleanHost})`,
        protocol: 'chromecast',
      });
      setDevices((prev) => {
        const filtered = prev.filter((d) => d.id !== device.id);
        return [device, ...filtered];
      });
      setShowManualForm(false);
      setManualHost('');
      setManualName('');
      await handleSelectDevice(device);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Não foi possível adicionar a TV.');
    }
  };

  const handleExternalAppCast = async () => {
    if (!mediaPayload) {
      onToast('Nenhum vídeo pronto para enviar.');
      return;
    }
    setPreparingExternal(true);
    try {
      onPauseLocalPlayback?.();
      const res = await prepareExternalTvCast(mediaPayload, true);
      if (res?.opened) {
        onToast('Abrindo seletor de app de TV — o servidor continua em 2º plano.');
      } else {
        onToast('Nenhum app externo de TV compatível encontrado.');
      }
    } catch {
      onToast('Falha ao abrir app externo de transmissão.');
    } finally {
      setPreparingExternal(false);
    }
  };

  const handleCopyTvStreamLink = async () => {
    if (!mediaPayload) {
      onToast('Nenhum stream carregado ainda.');
      return;
    }
    setPreparingExternal(true);
    try {
      let urlToCopy = mediaPayload.streamUrl;
      let usedLanProxy = false;
      if (canAutoDiscover) {
        const res = await prepareExternalTvCast(mediaPayload, false);
        if (res?.lanStreamUrl) {
          urlToCopy = res.lanStreamUrl;
          usedLanProxy = true;
        }
      }
      await navigator.clipboard.writeText(urlToCopy);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2500);
      onToast(
        usedLanProxy
          ? 'Link Wi-Fi copiado! A TV reproduz direto da rede local sem depender da janela do player.'
          : 'Link do stream copiado para abrir na Smart TV ou player externo.'
      );
    } catch {
      onToast('Não foi possível copiar o link do stream.');
    } finally {
      setPreparingExternal(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Transmitir para TV"
      data-tv-cast-modal="true"
      className="fixed inset-0 z-[75] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-white/12 bg-[#151921] text-slate-100 shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
                castState.active
                  ? 'border-[#f97316]/50 bg-[#f97316]/15 text-[#fb923c]'
                  : 'border-white/12 bg-[#0d0f12] text-slate-200'
              }`}
            >
              <Cast className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-white sm:text-base">
                Transmitir para TV
              </h2>
              <p className="truncate text-[11px] text-slate-400">
                {castState.active
                  ? `${castState.deviceName} · ${formatCastStatusLabel(castState.status)}`
                  : 'Chromecast, Android TV e Smart TVs na mesma rede Wi-Fi'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar transmissão para TV"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          {/* Background Independence Info Banner */}
          <div
            data-cast-background-banner="true"
            className="flex items-start gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-emerald-100"
          >
            <Radio className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>
              <strong className="font-semibold text-white">Sem precisar ficar com o app aberto:</strong>{' '}
              {isNativeAndroid
                ? 'a transmissão roda em segundo plano no serviço de mídia do Android — você pode sair do Anisync ou bloquear a tela e controlar pela notificação.'
                : canAutoDiscover
                  ? 'as TVs no mesmo Wi-Fi aparecem abaixo automaticamente. Escolha sua TV para enviar o episódio e continuar assistindo mesmo fechando a aba.'
                  : 'ao enviar o vídeo para Chromecast, AirPlay ou Smart TV, a TV reproduz de forma independente da janela do player.'}
            </span>
          </div>

          {castState.errorMessage && (
            <div className="rounded-xl border border-rose-500/35 bg-rose-500/12 px-3.5 py-2.5 text-xs text-rose-200">
              {castState.errorMessage}
            </div>
          )}

          {/* Active Remote Controller */}
          {castState.active && (
            <div
              data-cast-active-controller="true"
              className="space-y-3.5 rounded-xl border border-[#f97316]/40 bg-[#0d0f12] p-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#fb923c]">
                    <Tv className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{castState.deviceName}</span>
                  </div>
                  <p className="mt-0.5 truncate text-sm font-bold text-white">
                    {castState.episodeTitle || mediaPayload?.title || 'Transmitindo'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {formatCastDeliveryLabel(castState.deliveryMode) ||
                      formatCastStatusLabel(castState.status)}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-[#f97316]/35 bg-[#f97316]/15 px-2.5 py-0.5 text-[10px] font-semibold text-[#fb923c]">
                  {formatCastStatusLabel(castState.status)}
                </span>
              </div>

              {castState.deliveryMode !== 'lan-link' && (
                <>
                  {/* Remote Seekbar — press, hold, drag smoothly, and seek on release */}
                  <div className="space-y-1">
                    <div
                      ref={seekTrackRef}
                      role="slider"
                      tabIndex={0}
                      data-cast-seekbar="true"
                      aria-label="Posição na TV"
                      aria-valuemin={0}
                      aria-valuemax={seekMaxMs}
                      aria-valuenow={displayedPositionMs}
                      aria-valuetext={formatCastDurationMs(displayedPositionMs)}
                      onPointerDown={handleSeekPointerDown}
                      onPointerMove={handleSeekPointerMove}
                      onPointerUp={handleSeekPointerUp}
                      onPointerCancel={handleSeekPointerCancel}
                      onKeyDown={handleSeekKeyDown}
                      className="group relative flex h-9 w-full touch-none select-none cursor-pointer items-center focus:outline-none"
                    >
                      {isScrubbing && (
                        <div
                          style={{ left: `${previewBubblePct}%` }}
                          className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md border border-[#f97316]/50 bg-[#151921] px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums text-[#fb923c] shadow-lg"
                        >
                          {formatCastDurationMs(displayedPositionMs)}
                        </div>
                      )}
                      <div className="relative h-2 w-full rounded-full bg-white/15">
                        <div
                          style={{ width: `${seekProgressPct}%` }}
                          className="h-full rounded-full bg-[#f97316]"
                        />
                        <div
                          style={{ left: `${seekProgressPct}%` }}
                          className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f97316] shadow-md transition-transform ${
                            isScrubbing
                              ? 'h-5 w-5 scale-110 ring-4 ring-[#f97316]/35'
                              : 'h-4 w-4 ring-2 ring-white/25 group-hover:scale-110'
                          }`}
                        />
                      </div>
                    </div>
                    <div className="flex justify-between font-mono text-[11px] tabular-nums text-slate-400">
                      <span className={isScrubbing ? 'font-semibold text-[#fb923c]' : undefined}>
                        {formatCastDurationMs(displayedPositionMs)}
                      </span>
                      <span>{formatCastDurationMs(castState.durationMs)}</span>
                    </div>
                  </div>

                  {/* Playback Buttons */}
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {castState.hasPrev && (
                      <button
                        type="button"
                        onClick={() => {
                          setPendingSeek(null);
                          void tvCastPrevEpisode();
                        }}
                        aria-label="Episódio anterior na TV"
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
                      >
                        <SkipBack className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRelativeSeek(-15_000)}
                      aria-label="Voltar 15 segundos na TV"
                      className="inline-flex h-10 items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-semibold text-slate-200 hover:bg-white/10"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>-15s</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void (isPlayingOrBuffering ? tvCastPause() : tvCastPlay())
                      }
                      aria-label={isPlayingOrBuffering ? 'Pausar na TV' : 'Reproduzir na TV'}
                      className="flex h-11 w-11 items-center justify-center rounded-full bg-[#f97316] text-[#0d0f12] shadow-lg hover:bg-[#fb923c]"
                    >
                      {castState.status === 'connecting' || castState.status === 'buffering' ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : isPlayingOrBuffering ? (
                        <Pause className="h-5 w-5 fill-current" />
                      ) : (
                        <Play className="ml-0.5 h-5 w-5 fill-current" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRelativeSeek(15_000)}
                      aria-label="Avançar 15 segundos na TV"
                      className="inline-flex h-10 items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-semibold text-slate-200 hover:bg-white/10"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      <span>+15s</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRelativeSeek(skipIntroSeconds * 1000)}
                      title={`Pular abertura (+${skipIntroSeconds}s)`}
                      className="inline-flex h-10 items-center rounded-xl border border-[#f97316]/40 bg-[#f97316]/12 px-2.5 font-mono text-xs font-bold text-[#fb923c] hover:bg-[#f97316]/20"
                    >
                      +{skipIntroSeconds}s
                    </button>
                    {castState.hasNext && (
                      <button
                        type="button"
                        onClick={() => {
                          setPendingSeek(null);
                          void tvCastNextEpisode();
                        }}
                        aria-label="Próximo episódio na TV"
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
                      >
                        <SkipForward className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {/* Volume Slider — drag smoothly and apply on release */}
                  <div className="flex items-center gap-2.5 pt-1">
                    <Volume2 className="h-4 w-4 shrink-0 text-slate-400" />
                    <div
                      ref={volumeTrackRef}
                      role="slider"
                      tabIndex={0}
                      data-cast-volume-slider="true"
                      aria-label="Volume da TV"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(volumePct)}
                      aria-valuetext={`${Math.round(volumePct)}%`}
                      onPointerDown={handleVolumePointerDown}
                      onPointerMove={handleVolumePointerMove}
                      onPointerUp={handleVolumePointerUp}
                      onPointerCancel={handleVolumePointerCancel}
                      onKeyDown={handleVolumeKeyDown}
                      className="group relative flex h-8 flex-1 touch-none select-none cursor-pointer items-center focus:outline-none"
                    >
                      <div className="relative h-1.5 w-full rounded-full bg-white/15">
                        <div
                          style={{ width: `${volumePct}%` }}
                          className="h-full rounded-full bg-[#f97316]"
                        />
                        <div
                          style={{ left: `${volumePct}%` }}
                          className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f97316] shadow-md transition-transform ${
                            isDraggingVolume
                              ? 'h-4.5 w-4.5 scale-110 ring-4 ring-[#f97316]/35'
                              : 'h-3.5 w-3.5 ring-2 ring-white/20 group-hover:scale-110'
                          }`}
                        />
                      </div>
                    </div>
                    <span
                      className={`w-9 text-right font-mono text-[11px] tabular-nums ${
                        isDraggingVolume ? 'font-semibold text-[#fb923c]' : 'text-slate-400'
                      }`}
                    >
                      {Math.round(volumePct)}%
                    </span>
                  </div>
                </>
              )}

              {/* Server Switcher right inside Active Remote Controller */}
              {onSelectCastServer && (serverOptions.length > 0 || loadingServers) && (
                <div
                  data-cast-server-switcher="true"
                  className="space-y-2 border-t border-white/10 pt-3"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-300">
                    <span className="inline-flex items-center gap-1.5">
                      <Server className="h-3.5 w-3.5 text-[#f97316]" />
                      <span>Trocar servidor na TV</span>
                    </span>
                    {loadingServers && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#fb923c]">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>Carregando...</span>
                      </span>
                    )}
                  </div>
                  {serverOptions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {serverOptions.map((opt) => {
                        const isActiveServer = activeServerNume === opt.nume;
                        const isSwitching = switchingServerNume === opt.nume;
                        return (
                          <button
                            key={opt.nume}
                            type="button"
                            disabled={Boolean(switchingServerNume)}
                            onClick={() => void onSelectCastServer(opt, devices)}
                            className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-60 ${
                              isActiveServer
                                ? 'border-[#f97316] bg-[#f97316]/18 text-[#fb923c]'
                                : 'border-white/10 bg-[#151921] text-slate-300 hover:border-[#f97316]/50 hover:text-white'
                            }`}
                          >
                            {isSwitching && (
                              <Loader2 className="h-3 w-3 animate-spin text-[#fb923c]" />
                            )}
                            <span>{opt.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Active Session Actions */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex min-h-[40px] flex-1 items-center justify-center rounded-xl border border-white/12 bg-white/5 px-3 text-xs font-semibold text-slate-200 hover:bg-white/10"
                >
                  Continuar em 2º plano
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void tvCastStop();
                    onToast('Transmissão encerrada na TV.');
                  }}
                  className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl border border-rose-500/35 bg-rose-500/15 px-3.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/25"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  <span>Parar</span>
                </button>
              </div>
            </div>
          )}

          {/* Automatic Wi-Fi TV Discovery List (Android Native + Web Local Server) */}
          {canAutoDiscover && (
            <div data-cast-wifi-discovery="true" className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                  <Wifi className="h-3.5 w-3.5 text-[#f97316]" />
                  <span>TVs encontradas no Wi-Fi ({devices.length})</span>
                </span>
                <button
                  type="button"
                  disabled={scanning}
                  onClick={() => void runDiscovery()}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#0d0f12] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-[#f97316]/50 hover:text-white disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 text-[#f97316] ${scanning ? 'animate-spin' : ''}`} />
                  <span>{scanning ? 'Buscando...' : 'Buscar novamente'}</span>
                </button>
              </div>

              {discoveryError && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                  {discoveryError}
                </div>
              )}

              {devices.length === 0 ? (
                <div className="rounded-xl border border-white/8 bg-[#0d0f12]/70 px-4 py-5 text-center">
                  {scanning ? (
                    <div className="flex flex-col items-center gap-2 text-xs text-slate-300">
                      <Loader2 className="h-5 w-5 animate-spin text-[#f97316]" />
                      <span>Procurando Chromecasts, Android TVs e Smart TVs (DLNA)...</span>
                    </div>
                  ) : (
                    <div className="space-y-1 text-xs text-slate-400">
                      <p className="font-medium text-slate-300">
                        Nenhuma TV encontrada automaticamente.
                      </p>
                      <p className="text-[11px]">
                        {isNativeAndroid
                          ? 'Verifique se o celular e a TV estão ligados no mesmo Wi-Fi, ou conecte pelo IP da TV abaixo.'
                          : 'Verifique se este aparelho e a TV estão ligados no mesmo Wi-Fi (e permita rede local no firewall se solicitado), ou conecte pelo IP da TV abaixo.'}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {devices.map((dev) => {
                    const isCurrent = castState.active && castState.deviceId === dev.id;
                    const isBusy = connectingId === dev.id;
                    return (
                      <button
                        key={dev.id}
                        type="button"
                        disabled={isBusy || !mediaPayload}
                        onClick={() => void handleSelectDevice(dev)}
                        className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors disabled:opacity-50 ${
                          isCurrent
                            ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                            : 'border-white/10 bg-[#0d0f12] text-slate-200 hover:border-[#f97316]/50 hover:bg-white/[0.04]'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                              isCurrent
                                ? 'border-[#f97316]/50 bg-[#f97316]/20 text-[#fb923c]'
                                : 'border-white/10 bg-white/5 text-slate-300'
                            }`}
                          >
                            <Tv className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold text-white sm:text-sm">
                              {dev.name}
                            </div>
                            <div className="truncate text-[11px] text-slate-400">
                              {formatCastProtocolLabel(dev.protocol)}
                              {dev.model ? ` · ${dev.model}` : ''}
                            </div>
                          </div>
                        </div>
                        <span className="shrink-0 text-[11px] font-semibold text-[#fb923c]">
                          {isBusy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : isCurrent ? (
                            'Conectado'
                          ) : (
                            'Transmitir'
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Delivery Mode Preference */}
              <div className="rounded-xl border border-white/8 bg-[#0d0f12]/70 p-3">
                <div className="mb-2 text-[11px] font-semibold text-slate-400">
                  Modo de envio para TV
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'auto', label: 'Automático' },
                      { id: 'proxy', label: 'Proxy 2º plano' },
                      { id: 'direct', label: 'Direto na TV' },
                    ] as Array<{ id: TvCastDeliveryPreference; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setDeliveryPref(opt.id)}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                        deliveryPref === opt.id
                          ? 'border-[#f97316] bg-[#f97316]/15 text-[#fb923c]'
                          : 'border-white/10 bg-[#151921] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Manual IP Toggle */}
              {!showManualForm ? (
                <button
                  type="button"
                  onClick={() => setShowManualForm(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-[#fb923c]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Adicionar Chromecast / Android TV por IP manual</span>
                </button>
              ) : (
                <div className="space-y-2 rounded-xl border border-white/10 bg-[#0d0f12] p-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                    <span>Conectar por IP na rede Wi-Fi</span>
                    <button
                      type="button"
                      onClick={() => setShowManualForm(false)}
                      className="text-slate-400 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <input
                      type="text"
                      value={manualHost}
                      onChange={(e) => setManualHost(e.target.value)}
                      placeholder="IP da TV (ex: 192.168.1.50)"
                      className="rounded-lg border border-white/12 bg-[#151921] px-2.5 py-2 text-xs text-white placeholder-slate-500 sm:col-span-2"
                    />
                    <input
                      type="text"
                      value={manualPort}
                      onChange={(e) => setManualPort(e.target.value)}
                      placeholder="Porta (8009)"
                      className="rounded-lg border border-white/12 bg-[#151921] px-2.5 py-2 text-xs text-white placeholder-slate-500"
                    />
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                      placeholder="Nome opcional (ex: TV da Sala)"
                      className="flex-1 rounded-lg border border-white/12 bg-[#151921] px-2.5 py-2 text-xs text-white placeholder-slate-500"
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddManual()}
                      className="rounded-lg bg-[#f97316] px-3.5 py-2 text-xs font-bold text-[#0d0f12] hover:bg-[#fb923c]"
                    >
                      Conectar
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Web Remote Playback Option (Chrome / Edge / Safari AirPlay) */}
          {!isNativeAndroid && canPromptWebRemote && onPromptWebRemote && (
            <button
              type="button"
              onClick={() => void onPromptWebRemote()}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-[#f97316]/45 bg-[#f97316]/15 px-4 py-3 text-left transition-colors hover:bg-[#f97316]/25"
            >
              <div className="flex items-center gap-3">
                <Cast className="h-5 w-5 shrink-0 text-[#fb923c]" />
                <div>
                  <div className="text-sm font-bold text-white">
                    Transmitir pelo navegador (Chromecast / AirPlay)
                  </div>
                  <div className="text-[11px] text-slate-300">
                    Envia o vídeo diretamente para sua TV ou Apple TV na rede local.
                  </div>
                </div>
              </div>
              <ExternalLink className="h-4 w-4 shrink-0 text-[#fb923c]" />
            </button>
          )}

          {/* Universal External App / Smart TV Link Section */}
          <div className="space-y-2 border-t border-white/10 pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Outras opções de TV
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {isNativeAndroid && (
                <button
                  type="button"
                  disabled={preparingExternal || !mediaPayload}
                  onClick={() => void handleExternalAppCast()}
                  className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-xl border border-white/12 bg-[#0d0f12] px-3 py-2 text-xs font-semibold text-slate-200 transition-colors hover:border-[#f97316]/50 hover:text-white disabled:opacity-50"
                >
                  {preparingExternal ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                  ) : (
                    <ExternalLink className="h-3.5 w-3.5 text-[#f97316]" />
                  )}
                  <span>App de TV externo</span>
                </button>
              )}
              <button
                type="button"
                disabled={preparingExternal || !mediaPayload}
                onClick={() => void handleCopyTvStreamLink()}
                className={`inline-flex min-h-[42px] items-center justify-center gap-2 rounded-xl border border-white/12 bg-[#0d0f12] px-3 py-2 text-xs font-semibold text-slate-200 transition-colors hover:border-[#f97316]/50 hover:text-white disabled:opacity-50 ${
                  !isNativeAndroid ? 'sm:col-span-2' : ''
                }`}
              >
                {copiedLink ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-[#f97316]" />
                )}
                <span>
                  {copiedLink
                    ? 'Link copiado!'
                    : canAutoDiscover
                      ? 'Copiar link Wi-Fi (2º plano)'
                      : 'Copiar link do stream para Smart TV'}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
