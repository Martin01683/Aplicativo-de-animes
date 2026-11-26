import { useCallback, useEffect, useState } from 'react';
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
  SkipBack,
  SkipForward,
  Square,
  Tv,
  Volume2,
  Wifi,
  X,
} from 'lucide-react';
import {
  addManualTvCastDevice,
  addTvCastDevicesListener,
  discoverTvCastDevicesDetailed,
  formatCastDeliveryLabel,
  formatCastDurationMs,
  formatCastProtocolLabel,
  formatCastStatusLabel,
  isNativeAndroidCastSupported,
  prepareExternalTvCast,
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
  const [deliveryPref, setDeliveryPref] = useState<TvCastDeliveryPreference>('auto');
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualPort, setManualPort] = useState('8009');
  const [copiedLink, setCopiedLink] = useState(false);
  const [preparingExternal, setPreparingExternal] = useState(false);

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

  const handleSelectDevice = async (device: TvCastDevice) => {
    if (!mediaPayload) {
      onToast('Carregue o episódio antes de transmitir para a TV.');
      return;
    }
    setConnectingId(device.id);
    try {
      onPauseLocalPlayback?.();
      await startNativeTvCast(device, mediaPayload, deliveryPref);
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
                  {/* Remote Seekbar */}
                  <div className="space-y-1">
                    <input
                      type="range"
                      aria-label="Posição na TV"
                      min={0}
                      max={Math.max(castState.durationMs, castState.positionMs, 1000)}
                      step={1000}
                      value={castState.positionMs}
                      onChange={(e) => void tvCastSeek(Number(e.target.value))}
                      className="h-1.5 w-full cursor-pointer accent-[#f97316]"
                    />
                    <div className="flex justify-between font-mono text-[11px] tabular-nums text-slate-400">
                      <span>{formatCastDurationMs(castState.positionMs)}</span>
                      <span>{formatCastDurationMs(castState.durationMs)}</span>
                    </div>
                  </div>

                  {/* Playback Buttons */}
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {castState.hasPrev && (
                      <button
                        type="button"
                        onClick={() => void tvCastPrevEpisode()}
                        aria-label="Episódio anterior na TV"
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
                      >
                        <SkipBack className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void tvCastSeekBy(-15_000)}
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
                      onClick={() => void tvCastSeekBy(15_000)}
                      aria-label="Avançar 15 segundos na TV"
                      className="inline-flex h-10 items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-semibold text-slate-200 hover:bg-white/10"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      <span>+15s</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void tvCastSeekBy(skipIntroSeconds * 1000)}
                      title={`Pular abertura (+${skipIntroSeconds}s)`}
                      className="inline-flex h-10 items-center rounded-xl border border-[#f97316]/40 bg-[#f97316]/12 px-2.5 font-mono text-xs font-bold text-[#fb923c] hover:bg-[#f97316]/20"
                    >
                      +{skipIntroSeconds}s
                    </button>
                    {castState.hasNext && (
                      <button
                        type="button"
                        onClick={() => void tvCastNextEpisode()}
                        aria-label="Próximo episódio na TV"
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
                      >
                        <SkipForward className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {/* Volume Slider */}
                  <div className="flex items-center gap-2.5 pt-1">
                    <Volume2 className="h-4 w-4 shrink-0 text-slate-400" />
                    <input
                      type="range"
                      aria-label="Volume da TV"
                      min={0}
                      max={1}
                      step={0.05}
                      value={castState.volume}
                      onChange={(e) => void tvCastSetVolume(Number(e.target.value))}
                      className="h-1 flex-1 cursor-pointer accent-[#f97316]"
                    />
                    <span className="w-9 text-right font-mono text-[11px] tabular-nums text-slate-400">
                      {Math.round(castState.volume * 100)}%
                    </span>
                  </div>
                </>
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
