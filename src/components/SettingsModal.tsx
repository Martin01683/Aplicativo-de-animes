import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Bell,
  BellOff,
  CheckCircle2,
  Clock,
  Database,
  Download,
  ExternalLink,
  Film,
  Globe,
  HardDrive,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Server,
  Share2,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { apiFetch, type ApkDownloadProgressEvent } from '../lib/apiClient';
import {
  formatBytes,
  formatShortSha,
  GITHUB_RELEASES_PAGE_URL,
  type AppBuildInfo,
  type AppUpdateCheckResult,
} from '../lib/appUpdater';
import {
  parseAnisyncBackupJson,
  type AnisyncBackupPayload,
  type BackupImportMode,
  type BackupImportSummary,
} from '../lib/backup';
import { parseReleaseChangelog } from '../lib/changelogParser';
import type { NotificationPermissionStatus } from '../lib/notifications';
import {
  computeTotalOfflineBytes,
  formatDownloadSpeed,
  getDownloadEnginesInfo,
  updateYtDlpEngine,
  type DownloadEnginesInfo,
  type OfflineDownloadRecord,
} from '../lib/offlineDownloads';
import {
  VIDEO_SCALE_OPTIONS,
  type VideoScaleMode,
} from '../lib/playbackProgress';
import {
  APP_UPDATE_INTERVAL_OPTIONS,
  EPISODE_CHECK_INTERVAL_OPTIONS,
  formatRelativeTimestamp,
  type AppSettings,
  type AppSettingsMeta,
  type AppUpdateIntervalHours,
  type DefaultAudioFilter,
  type EpisodeCheckIntervalMinutes,
} from '../lib/settings';
import type { EpisodeSourceConfig, SourceTestResult } from '../lib/sources/types';
import type { CatalogSourceCredentials } from '../lib/types';
import type { NavSection } from './Header';

interface SettingsModalProps {
  open: boolean;
  focusSection?: 'sources' | 'catalog' | 'notifications' | 'updates' | 'general';
  onClose: () => void;
  settings: AppSettings;
  settingsMeta: AppSettingsMeta;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onResetSettings: () => void;
  // News & episode checking
  favoritesCount: number;
  mutedFavoritesCount: number;
  checkingEpisodes: boolean;
  notificationPermission: NotificationPermissionStatus;
  onCheckEpisodesNow: () => void;
  onRequestPushNotifications: () => void;
  onSendTestNotification: () => void;
  onUnmuteAllFavorites: () => void;
  // System & GitHub updates
  buildInfo: AppBuildInfo;
  isNativeAndroid: boolean;
  appUpdateResult: AppUpdateCheckResult | null;
  checkingAppUpdate: boolean;
  appUpdateError: string;
  downloadingAppUpdate: boolean;
  apkDownloadProgress: ApkDownloadProgressEvent | null;
  swUpdateAvailable: boolean;
  onCheckAppUpdateNow: () => void;
  onDownloadAppUpdate: () => void;
  onCancelAppUpdate: () => void;
  onDismissApkProgress: () => void;
  onApplySwUpdate: () => void;
  // Local data actions
  historyCount: number;
  alertsCount: number;
  onClearHistory: () => void;
  onClearAlerts: () => void;
  onExportBackup: (destination?: 'downloads' | 'share') => Promise<void> | void;
  onImportBackup: (payload: AnisyncBackupPayload, mode: BackupImportMode) => void;
  // Offline video downloads
  offlineDownloads?: OfflineDownloadRecord[];
  onOpenOfflineEpisode?: (record: OfflineDownloadRecord) => void;
  onCancelOfflineDownload?: (idOrUrl: string) => void;
  onDeleteOfflineDownload?: (idOrUrl: string) => void;
  onClearOfflineQueue?: () => void;
  onDeleteAllOfflineDownloads?: () => void;
}

interface ToggleSwitchProps {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}

function ToggleSwitch({ id, checked, onChange, disabled = false, label }: ToggleSwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f97316] disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? 'border-[#f97316] bg-[#f97316]'
          : 'border-white/15 bg-[#0d0f12]'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full transition-transform ${
          checked ? 'translate-x-6 bg-[#0d0f12]' : 'translate-x-1 bg-slate-400'
        }`}
      />
    </button>
  );
}

export function SettingsModal({
  open,
  focusSection = 'general',
  onClose,
  settings,
  settingsMeta,
  onUpdateSettings,
  onResetSettings,
  favoritesCount,
  mutedFavoritesCount,
  checkingEpisodes,
  notificationPermission,
  onCheckEpisodesNow,
  onRequestPushNotifications,
  onSendTestNotification,
  onUnmuteAllFavorites,
  buildInfo,
  isNativeAndroid,
  appUpdateResult,
  checkingAppUpdate,
  appUpdateError,
  downloadingAppUpdate,
  apkDownloadProgress,
  swUpdateAvailable,
  onCheckAppUpdateNow,
  onDownloadAppUpdate,
  onCancelAppUpdate,
  onDismissApkProgress,
  onApplySwUpdate,
  historyCount,
  alertsCount,
  onClearHistory,
  onClearAlerts,
  onExportBackup,
  onImportBackup,
  offlineDownloads = [],
  onOpenOfflineEpisode,
  onCancelOfflineDownload,
  onDeleteOfflineDownload,
  onClearOfflineQueue,
  onDeleteAllOfflineDownloads,
}: SettingsModalProps) {
  const sourcesSectionRef = useRef<HTMLElement>(null);
  const notificationsSectionRef = useRef<HTMLElement>(null);
  const updatesPanelRef = useRef<HTMLDivElement>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const [showCredsPanel, setShowCredsPanel] = useState(false);
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, SourceTestResult>>({});
  const [exportingBackup, setExportingBackup] = useState<'downloads' | 'share' | null>(null);
  const [backupError, setBackupError] = useState('');
  const [confirmClearAllOffline, setConfirmClearAllOffline] = useState(false);
  const [engineInfo, setEngineInfo] = useState<DownloadEnginesInfo | null>(null);
  const [updatingYtDlp, setUpdatingYtDlp] = useState(false);
  const [ytDlpStatusMsg, setYtDlpStatusMsg] = useState('');
  const [pendingBackupImport, setPendingBackupImport] = useState<{
    filename: string;
    payload: AnisyncBackupPayload;
    summary: BackupImportSummary;
  } | null>(null);

  const completedOfflineDownloads = useMemo(
    () => offlineDownloads.filter((d) => d.status === 'completed'),
    [offlineDownloads]
  );
  const queuedOfflineDownloads = useMemo(
    () => offlineDownloads.filter((d) => d.status === 'queued'),
    [offlineDownloads]
  );
  const totalOfflineBytes = useMemo(
    () => computeTotalOfflineBytes(offlineDownloads),
    [offlineDownloads]
  );

  useEffect(() => {
    if (!confirmClearAllOffline) return;
    const timer = window.setTimeout(() => setConfirmClearAllOffline(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmClearAllOffline]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void getDownloadEnginesInfo().then((info) => {
      if (active && info) setEngineInfo(info);
    });
    return () => {
      active = false;
    };
  }, [open]);

  const handleUpdateYtDlpClick = async () => {
    if (updatingYtDlp) return;
    setUpdatingYtDlp(true);
    setYtDlpStatusMsg('');
    try {
      const res = await updateYtDlpEngine();
      setYtDlpStatusMsg(res.message);
      const refreshed = await getDownloadEnginesInfo();
      if (refreshed) setEngineInfo(refreshed);
    } catch (err) {
      setYtDlpStatusMsg(
        err instanceof Error && err.message ? err.message : 'Falha ao atualizar yt-dlp.'
      );
    } finally {
      setUpdatingYtDlp(false);
    }
  };

  const parsedChangelogSections = useMemo(
    () => parseReleaseChangelog(appUpdateResult?.latestRelease?.notes),
    [appUpdateResult?.latestRelease?.notes]
  );

  const handleBackupFileSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBackupError('');
    try {
      const text = await file.text();
      const parsed = parseAnisyncBackupJson(text);
      if (!parsed.ok) {
        setPendingBackupImport(null);
        setBackupError(parsed.error);
        return;
      }
      setPendingBackupImport({
        filename: file.name,
        payload: parsed.payload,
        summary: parsed.summary,
      });
    } catch {
      setPendingBackupImport(null);
      setBackupError('Não foi possível ler o arquivo selecionado.');
    }
  };

  const handleExportBackupClick = async (destination: 'downloads' | 'share') => {
    if (exportingBackup) return;
    setBackupError('');
    setExportingBackup(destination);
    try {
      await onExportBackup(destination);
    } finally {
      setExportingBackup(null);
    }
  };

  const handleConfirmBackupImport = (mode: BackupImportMode) => {
    if (!pendingBackupImport) return;
    onImportBackup(pendingBackupImport.payload, mode);
    setPendingBackupImport(null);
    setBackupError('');
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const target =
      focusSection === 'sources'
        ? sourcesSectionRef.current
        : focusSection === 'notifications'
          ? notificationsSectionRef.current
          : focusSection === 'updates'
            ? updatesPanelRef.current
            : null;
    if (!target) return;
    const rafId = window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [open, focusSection]);

  if (!open) return null;

  const latestRelease = appUpdateResult?.latestRelease || null;
  const hasUpdate = Boolean(appUpdateResult?.hasUpdate && latestRelease);
  const currentVersionLabel = buildInfo.androidVersionName || `v${buildInfo.version}`;

  const formatReleaseDate = (iso: string) => {
    if (!iso) return '—';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '—';
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(ts));
    } catch {
      return iso;
    }
  };

  const handleTestSource = async (source: EpisodeSourceConfig) => {
    setTestingSourceId(source.id);
    try {
      const res = await apiFetch('/api/sources/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const data = (await res.json()) as SourceTestResult;
      setTestResults((prev) => ({ ...prev, [source.id]: data }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [source.id]: {
          ok: false,
          sourceId: source.id,
          sourceName: source.name,
          message: err instanceof Error ? err.message : 'Falha ao testar fonte.',
          latencyMs: 0,
        },
      }));
    } finally {
      setTestingSourceId(null);
    }
  };

  const updateCredentialField = (key: keyof CatalogSourceCredentials, value: string) => {
    onUpdateSettings({
      catalogCredentials: {
        ...settings.catalogCredentials,
        [key]: value.trim() || undefined,
      },
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-white/12 bg-[#151921] text-[#f1f5f9] shadow-2xl sm:rounded-2xl"
      >
        {/* Sticky Modal Header */}
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4 sm:px-6">
          <div>
            <h2 id="settings-modal-title" className="text-lg font-bold text-white">
              Configurações do Anisync
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Provedores de episódios, metadados TheTVDB, notas MyAnimeList, calendário LiveChart.me e player
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar configurações"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-[#0d0f12] text-slate-300 transition-colors hover:border-white/25 hover:text-white"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5 sm:px-6 sm:py-6">
          {/* 1. Fontes de Episódios e Servidores (Sites & Nuvem) */}
          <section
            ref={sourcesSectionRef}
            aria-labelledby="settings-episode-sources-heading"
            className="space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2.5">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-[#f97316]" />
                <h3 id="settings-episode-sources-heading" className="text-base font-semibold text-white">
                  Provedores
                </h3>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-slate-400">
              O Início, o Catálogo, a Busca e os Episódios consultam os provedores integrados abaixo para localizar os servidores de vídeo.
            </p>

            {/* Configured Episode Sources List */}
            <div className="divide-y divide-white/8 rounded-xl border border-white/10 bg-[#0d0f12]/70">
              {settings.episodeSources.map((src) => {
                const testResult = testResults[src.id];
                return (
                  <div key={src.id} className="space-y-2 px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1 text-sm font-semibold text-white">
                            <Globe className="h-3.5 w-3.5 text-[#f97316]" />
                            {src.name}
                          </span>
                          {src.builtIn && (
                            <span className="rounded bg-[#f97316]/15 px-1.5 py-0.5 text-[10px] font-medium text-[#fb923c]">
                              Integrado
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate font-mono text-[11px] text-slate-400">
                          {src.baseUrl}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400">
                          {src.supportsMedia.map((m) => (
                            <span key={m} className="rounded border border-white/10 px-1.5 py-0.5">
                              {m === 'anime' ? 'Animes' : m === 'series' ? 'Séries' : 'Filmes'}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled={testingSourceId === src.id}
                          onClick={() => void handleTestSource(src)}
                          className="rounded-md border border-white/10 bg-[#151921] px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-[#f97316]/50 hover:text-white disabled:opacity-50"
                        >
                          {testingSourceId === src.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                          ) : (
                            'Testar'
                          )}
                        </button>
                      </div>
                    </div>

                    {testResult && (
                      <p
                        className={`text-[11px] font-medium ${
                          testResult.ok ? 'text-emerald-300' : 'text-amber-300'
                        }`}
                      >
                        {testResult.message}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* 2. Metadados (TheTVDB) & Calendário (LiveChart.me) */}
          <section aria-labelledby="settings-catalog-sources-heading" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2.5">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-[#f97316]" />
                <h3 id="settings-catalog-sources-heading" className="text-base font-semibold text-white">
                  Informações &amp; Calendário
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCredsPanel((prev) => !prev)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-[#f97316]/50 hover:text-white"
              >
                <KeyRound className="h-3.5 w-3.5 text-[#f97316]" />
                <span>{showCredsPanel ? 'Ocultar chave TheTVDB' : 'Chave TheTVDB (opcional)'}</span>
              </button>
            </div>

            <div className="divide-y divide-white/8 rounded-xl border border-white/10 bg-[#0d0f12]/70">
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-200">TheTVDB</span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Sinopses, títulos de episódios, capas, estúdios, redes, classificação, gêneros, temporadas e datas oficiais.
                  </span>
                </div>
                <span className="rounded-md border border-[#f97316]/35 bg-[#f97316]/12 px-2 py-0.5 text-[11px] font-semibold text-[#fb923c]">
                  Ativo
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-200">MyAnimeList</span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Notas e avaliações da comunidade para os animes.
                  </span>
                </div>
                <span className="rounded-md border border-[#f97316]/35 bg-[#f97316]/12 px-2 py-0.5 text-[11px] font-semibold text-[#fb923c]">
                  Ativo
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-200">LiveChart.me</span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Calendário semanal, horários oficiais de estreia, contagem regressiva, Dub/Sub e plataformas de streaming.
                  </span>
                </div>
                <span className="rounded-md border border-[#f97316]/35 bg-[#f97316]/12 px-2 py-0.5 text-[11px] font-semibold text-[#fb923c]">
                  Ativo
                </span>
              </div>
            </div>

            {showCredsPanel && (
              <div className="space-y-3 rounded-xl border border-white/10 bg-[#0d0f12]/80 p-4">
                <p className="text-xs leading-relaxed text-slate-400">
                  O TheTVDB já funciona automaticamente sem chave. Caso possua uma chave pessoal da API v4 do TheTVDB, informe abaixo para consultas autenticadas:
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="cred-tvdb-key" className="mb-1 block text-xs font-medium text-slate-300">
                      TheTVDB v4 API Key
                    </label>
                    <input
                      id="cred-tvdb-key"
                      type="password"
                      value={settings.catalogCredentials.tvdbApiKey || ''}
                      onChange={(e) => updateCredentialField('tvdbApiKey', e.target.value)}
                      placeholder="Opcional"
                      className="w-full rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs text-white focus:border-[#f97316] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="cred-tvdb-pin" className="mb-1 block text-xs font-medium text-slate-300">
                      TheTVDB Subscriber PIN
                    </label>
                    <input
                      id="cred-tvdb-pin"
                      type="password"
                      value={settings.catalogCredentials.tvdbPin || ''}
                      onChange={(e) => updateCredentialField('tvdbPin', e.target.value)}
                      placeholder="Opcional"
                      className="w-full rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs text-white focus:border-[#f97316] focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 3. Notificações e Alertas */}
          <section
            ref={notificationsSectionRef}
            aria-labelledby="settings-news-heading"
            className="space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2.5">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-[#f97316]" />
                <h3 id="settings-news-heading" className="text-base font-semibold text-white">
                  Notificações e Alertas
                </h3>
              </div>
              <span className="text-xs tabular-nums text-slate-400">
                {favoritesCount} favorito{favoritesCount === 1 ? '' : 's'} ·{' '}
                {formatRelativeTimestamp(settingsMeta.lastEpisodeCheckAt)}
              </span>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="episode-frequency-select"
                className="block text-sm font-medium text-slate-200"
              >
                Intervalo de verificação automática de novos episódios
              </label>
              <p className="text-xs text-slate-400">
                Define de quanto em quanto tempo o Anisync consulta o catálogo e seus favoritos (até 30 títulos) para detectar novos lançamentos.
              </p>
              <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-4">
                {EPISODE_CHECK_INTERVAL_OPTIONS.map((opt) => {
                  const active = settings.episodeCheckIntervalMinutes === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        onUpdateSettings({
                          episodeCheckIntervalMinutes: opt.value as EpisodeCheckIntervalMinutes,
                        })
                      }
                      aria-pressed={active}
                      className={`min-h-[42px] whitespace-nowrap rounded-lg border px-2.5 py-2 text-xs font-medium tabular-nums transition-colors ${
                        active
                          ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                          : 'border-white/10 bg-[#0d0f12] text-slate-300 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      {opt.shortLabel}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="divide-y divide-white/8 rounded-xl border border-white/10 bg-[#0d0f12]/70">
              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <label htmlFor="toggle-check-startup" className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-sm font-medium text-slate-200">
                    Verificar novidades ao abrir o app
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Checa automaticamente ao abrir ou ao retornar após o intervalo configurado.
                  </span>
                </label>
                <ToggleSwitch
                  id="toggle-check-startup"
                  checked={settings.checkEpisodesOnStartup}
                  onChange={(val) => onUpdateSettings({ checkEpisodesOnStartup: val })}
                  label="Verificar novidades ao abrir o app"
                />
              </div>

              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <label htmlFor="toggle-device-notifications" className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-sm font-medium text-slate-200">
                    Notificações no dispositivo
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    {notificationPermission === 'granted'
                      ? isNativeAndroid
                        ? 'Permissão ativa no Android — toques abrem o episódio direto no app.'
                        : 'Permissão ativa no navegador — toques abrem o episódio direto.'
                      : notificationPermission === 'denied'
                        ? 'Bloqueada no aparelho/navegador — os avisos continuam na Central de Notificações.'
                        : notificationPermission === 'unsupported'
                          ? 'Alertas exibidos na Central de Notificações dentro do aplicativo.'
                          : 'Ative para receber alertas do sistema mesmo em segundo plano.'}
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  {notificationPermission === 'default' && (
                    <button
                      type="button"
                      onClick={onRequestPushNotifications}
                      className="min-h-[38px] whitespace-nowrap rounded-lg border border-[#f97316]/40 bg-[#f97316]/12 px-3 py-1.5 text-xs font-medium text-[#fb923c] hover:bg-[#f97316]/20"
                    >
                      Permitir
                    </button>
                  )}
                  <ToggleSwitch
                    id="toggle-device-notifications"
                    checked={settings.notifyNewEpisodes}
                    onChange={(val) => onUpdateSettings({ notifyNewEpisodes: val })}
                    label="Notificações no dispositivo"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <label htmlFor="toggle-inapp-toasts" className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-sm font-medium text-slate-200">
                    Avisos flutuantes de novos episódios
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Mostra um cartão com capa e atalho &ldquo;Assistir&rdquo; quando um episódio novo chegar.
                  </span>
                </label>
                <ToggleSwitch
                  id="toggle-inapp-toasts"
                  checked={settings.showInAppEpisodeToasts}
                  onChange={(val) => onUpdateSettings({ showInAppEpisodeToasts: val })}
                  label="Avisos flutuantes de novos episódios"
                />
              </div>

              <div className="flex flex-col items-start gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="w-full min-w-0 sm:flex-1">
                  <span className="block text-sm font-medium text-slate-200">
                    Filtro de áudio para notificações
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Receba avisos apenas de episódios dublados, legendados ou ambos.
                  </span>
                </div>
                <div className="grid w-full shrink-0 grid-cols-3 gap-1 rounded-lg border border-white/10 bg-[#151921] p-1 sm:flex sm:w-auto sm:items-center">
                  {(
                    [
                      { id: 'ALL', label: 'Todos' },
                      { id: 'DUB', label: 'Dublados' },
                      { id: 'LEG', label: 'Legendados' },
                    ] as Array<{ id: DefaultAudioFilter; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => onUpdateSettings({ notifyAudioFilter: opt.id })}
                      aria-pressed={settings.notifyAudioFilter === opt.id}
                      className={`min-h-[36px] whitespace-nowrap rounded-md px-3 py-1 text-center text-xs font-medium transition-colors ${
                        settings.notifyAudioFilter === opt.id
                          ? 'bg-[#f97316] text-[#0d0f12]'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {mutedFavoritesCount > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-200">
                      <BellOff className="h-3.5 w-3.5 text-slate-400" />
                      <span>
                        {mutedFavoritesCount}{' '}
                        {mutedFavoritesCount === 1
                          ? 'anime silenciado'
                          : 'animes silenciados'}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-400">
                      Títulos silenciados na Minha Lista não geram novos avisos.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={onUnmuteAllFavorites}
                    className="min-h-[38px] whitespace-nowrap rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
                  >
                    Reativar todos
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <button
                type="button"
                onClick={onSendTestNotification}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-white/12 bg-[#0d0f12] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
              >
                <Send className="h-3.5 w-3.5 text-[#f97316]" />
                <span>Enviar notificação de teste</span>
              </button>

              <button
                type="button"
                disabled={checkingEpisodes}
                onClick={onCheckEpisodesNow}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-white/12 bg-[#0d0f12] px-4 py-2 text-xs font-semibold text-white transition-colors hover:border-[#f97316]/60 disabled:opacity-50"
              >
                {checkingEpisodes ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 text-[#f97316]" />
                )}
                <span>{checkingEpisodes ? 'Buscando novidades...' : 'Verificar novidades agora'}</span>
              </button>
            </div>
          </section>

          {/* 4. Atualizações do Sistema (GitHub Releases) */}
          <section aria-labelledby="settings-updates-heading" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2.5">
              <div className="flex items-center gap-2">
                <Download className="h-4 w-4 text-[#f97316]" />
                <h3 id="settings-updates-heading" className="text-base font-semibold text-white">
                  Atualizações do Sistema
                </h3>
              </div>
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {currentVersionLabel} · {formatShortSha(buildInfo.commitSha)}
                {buildInfo.androidVersionCode ? ` (#${buildInfo.androidVersionCode})` : ''}
              </span>
            </div>

            <div className="divide-y divide-white/8 rounded-xl border border-white/10 bg-[#0d0f12]/70">
              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <label htmlFor="toggle-auto-app-update" className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-sm font-medium text-slate-200">
                    Buscar atualizações automaticamente
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Consulta as releases oficiais no GitHub ({buildInfo.repository}).
                  </span>
                </label>
                <ToggleSwitch
                  id="toggle-auto-app-update"
                  checked={settings.autoCheckAppUpdates}
                  onChange={(val) => onUpdateSettings({ autoCheckAppUpdates: val })}
                  label="Buscar atualizações automaticamente"
                />
              </div>

              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <label
                  htmlFor="toggle-check-app-update-startup"
                  className="min-w-0 flex-1 cursor-pointer"
                >
                  <span className="block text-sm font-medium text-slate-200">
                    Verificar atualizações ao abrir o app
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Checa automaticamente se há uma nova versão assim que o programa for aberto.
                  </span>
                </label>
                <ToggleSwitch
                  id="toggle-check-app-update-startup"
                  checked={settings.checkAppUpdatesOnStartup}
                  onChange={(val) => onUpdateSettings({ checkAppUpdatesOnStartup: val })}
                  label="Verificar atualizações ao abrir o app"
                />
              </div>

              <div className="flex flex-col items-start gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <label htmlFor="app-update-interval-select" className="w-full min-w-0 sm:flex-1">
                  <span className="block text-sm font-medium text-slate-200">
                    Frequência de verificação do app
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Periodicidade da checagem automática de novas versões.
                  </span>
                </label>
                <select
                  id="app-update-interval-select"
                  disabled={!settings.autoCheckAppUpdates}
                  value={settings.appUpdateIntervalHours}
                  onChange={(e) =>
                    onUpdateSettings({
                      appUpdateIntervalHours: Number(e.target.value) as AppUpdateIntervalHours,
                    })
                  }
                  className="min-h-[40px] w-full shrink-0 rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none disabled:opacity-50 sm:w-auto"
                >
                  {APP_UPDATE_INTERVAL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <label htmlFor="toggle-auto-download-update" className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-sm font-medium text-slate-200">
                    Baixar automaticamente quando houver nova versão
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    {isNativeAndroid
                      ? 'Baixa o Anisync.apk oficial no app, verifica SHA-256 e assinatura e inicia o instalador do sistema.'
                      : 'Inicia automaticamente o download do novo Anisync.apk publicado no GitHub.'}
                  </span>
                </label>
                <ToggleSwitch
                  id="toggle-auto-download-update"
                  checked={settings.autoDownloadAppUpdates}
                  onChange={(val) => onUpdateSettings({ autoDownloadAppUpdates: val })}
                  label="Baixar automaticamente quando houver nova versão"
                />
              </div>
            </div>

            {/* Manual Check + Update Status Panel */}
            <div
              id="settings-updates-panel"
              ref={updatesPanelRef}
              className="scroll-mt-4 space-y-3 rounded-xl border border-white/10 bg-[#0d0f12]/70 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-400">
                  Última verificação:{' '}
                  <span className="font-medium text-slate-200">
                    {formatRelativeTimestamp(settingsMeta.lastAppUpdateCheckAt)}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={checkingAppUpdate}
                  onClick={onCheckAppUpdateNow}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c] disabled:opacity-50"
                >
                  {checkingAppUpdate ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {checkingAppUpdate ? 'Verificando GitHub...' : 'Verificar atualizações agora'}
                  </span>
                </button>
              </div>

              {appUpdateError && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-200">
                  {appUpdateError}
                </div>
              )}

              {appUpdateResult && !appUpdateError && (
                <div className="border-t border-white/8 pt-3">
                  {latestRelease ? (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            {hasUpdate ? (
                              <Download className="h-4 w-4 text-[#f97316]" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                            )}
                            <span className="text-sm font-semibold text-white">
                              {hasUpdate
                                ? `Nova versão disponível: ${latestRelease.releaseName}`
                                : 'Você já está na versão mais recente'}
                            </span>
                          </div>
                          <p className="font-mono text-xs tabular-nums text-slate-400">
                            {latestRelease.tagName} · {formatShortSha(latestRelease.commitSha)} ·{' '}
                            {formatReleaseDate(latestRelease.updatedAt)}
                            {latestRelease.apkAsset?.sizeBytes
                              ? ` · ${formatBytes(latestRelease.apkAsset.sizeBytes)}`
                              : ''}
                          </p>
                        </div>
                      </div>

                      {latestRelease.notes && (
                        <div
                          data-release-changelog="true"
                          className="max-h-48 overflow-y-auto rounded-lg border border-white/8 bg-[#151921]/80 px-3 py-2.5 text-xs leading-relaxed text-slate-300"
                        >
                          {parsedChangelogSections.length > 0 ? (
                            <div className="space-y-2.5">
                              {parsedChangelogSections.map((section) => (
                                <div key={section.title} className="space-y-1">
                                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[#fb923c]">
                                    {section.title}
                                  </p>
                                  <ul className="space-y-1">
                                    {section.items.map((item, idx) => (
                                      <li
                                        key={`${section.title}-${idx}`}
                                        className={item.isBullet ? 'flex items-start gap-1.5' : 'text-slate-300'}
                                      >
                                        {item.isBullet && (
                                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-500" />
                                        )}
                                        <span className="min-w-0 break-words">
                                          {item.scope ? (
                                            <>
                                              <span className="font-semibold text-slate-100">
                                                {item.scope}:
                                              </span>{' '}
                                              {item.text}
                                            </>
                                          ) : (
                                            item.text
                                          )}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="whitespace-pre-line break-words">
                              {latestRelease.notes}
                            </div>
                          )}
                        </div>
                      )}

                      {(downloadingAppUpdate ||
                        (apkDownloadProgress && apkDownloadProgress.stage !== 'cancelled')) && (
                        <div className="space-y-2 rounded-lg border border-white/8 bg-[#151921] p-3">
                          <div className="flex items-center justify-between gap-2.5 text-xs">
                            <span className="min-w-0 flex-1 font-medium leading-snug text-slate-200">
                              {apkDownloadProgress?.stage === 'verifying'
                                ? 'Verificando integridade SHA-256 e assinatura...'
                                : apkDownloadProgress?.stage === 'installing'
                                  ? 'Abrindo instalador do sistema Android...'
                                  : apkDownloadProgress?.stage === 'installed'
                                    ? 'Atualização concluída!'
                                    : apkDownloadProgress?.stage === 'error'
                                      ? apkDownloadProgress.message || 'Falha ao atualizar APK.'
                                      : `Baixando atualização... ${apkDownloadProgress?.percent ?? 0}%`}
                            </span>
                            {apkDownloadProgress?.stage === 'error' ||
                            apkDownloadProgress?.stage === 'installed' ? (
                              <button
                                type="button"
                                onClick={onDismissApkProgress}
                                aria-label="Fechar aviso de atualização"
                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-[#0d0f12] text-slate-400 transition-colors hover:border-white/25 hover:text-white"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={onCancelAppUpdate}
                                className="inline-flex min-h-[34px] shrink-0 items-center gap-1 rounded-md border border-white/12 bg-[#0d0f12] px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:border-rose-500/45 hover:text-rose-200"
                              >
                                <X className="h-3.5 w-3.5" />
                                <span>Cancelar</span>
                              </button>
                            )}
                          </div>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                            <div
                              className={`h-full rounded-full transition-all duration-200 ${
                                apkDownloadProgress?.stage === 'error'
                                  ? 'bg-red-500'
                                  : apkDownloadProgress?.stage === 'installed'
                                    ? 'bg-emerald-400'
                                    : 'bg-[#f97316]'
                              }`}
                              style={{
                                width: `${Math.min(
                                  100,
                                  Math.max(
                                    apkDownloadProgress?.stage === 'verifying' ||
                                      apkDownloadProgress?.stage === 'installing' ||
                                      apkDownloadProgress?.stage === 'installed'
                                      ? 100
                                      : 6,
                                    apkDownloadProgress?.percent ?? 6
                                  )
                                )}%`,
                              }}
                            />
                          </div>
                          {apkDownloadProgress && apkDownloadProgress.downloadedBytes > 0 && (
                            <div className="flex justify-end text-[11px] font-mono tabular-nums text-slate-400">
                              {formatBytes(apkDownloadProgress.downloadedBytes)}
                              {apkDownloadProgress.totalBytes > 0
                                ? ` / ${formatBytes(apkDownloadProgress.totalBytes)}`
                                : ''}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        {latestRelease.apkAsset && (
                          <button
                            type="button"
                            disabled={downloadingAppUpdate}
                            onClick={onDownloadAppUpdate}
                            className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
                              hasUpdate
                                ? 'bg-[#f97316] text-[#0d0f12] hover:bg-[#fb923c]'
                                : 'border border-white/12 bg-[#151921] text-slate-200 hover:border-[#f97316]/60 hover:text-white'
                            }`}
                          >
                            {downloadingAppUpdate ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Download className="h-3.5 w-3.5" />
                            )}
                            <span>
                              {hasUpdate
                                ? `Baixar atualização (${latestRelease.apkAsset.name})`
                                : `Baixar ${latestRelease.apkAsset.name}`}
                            </span>
                          </button>
                        )}

                        <a
                          href={latestRelease.htmlUrl || GITHUB_RELEASES_PAGE_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-white/25 hover:text-white"
                        >
                          <span>Ver release no GitHub</span>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">
                      Nenhuma release publicada ainda no repositório do GitHub.
                    </p>
                  )}
                </div>
              )}

              {swUpdateAvailable && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-3">
                  <span className="text-xs text-[#fb923c]">
                    Nova atualização web em cache pronta para aplicar.
                  </span>
                  <button
                    type="button"
                    onClick={onApplySwUpdate}
                    className="min-h-[38px] rounded-lg bg-[#f97316] px-3 py-1.5 text-xs font-semibold text-[#0d0f12] hover:bg-[#fb923c]"
                  >
                    Recarregar app Web
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* 5. Preferências de Reprodução e Dados Locais */}
          <section aria-labelledby="settings-player-heading" className="space-y-4">
            <div className="flex items-center gap-2 border-b border-white/8 pb-2.5">
              <Film className="h-4 w-4 text-[#f97316]" />
              <h3 id="settings-player-heading" className="text-base font-semibold text-white">
                Preferências e Reprodução
              </h3>
            </div>

            <div className="divide-y divide-white/8 rounded-xl border border-white/10 bg-[#0d0f12]/70">
              <div className="flex flex-col items-start gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <label htmlFor="default-section-select" className="w-full min-w-0 sm:flex-1">
                  <span className="block text-sm font-medium text-slate-200">
                    Aba inicial ao abrir o Anisync
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Escolha qual tela abrir primeiro ao iniciar.
                  </span>
                </label>
                <select
                  id="default-section-select"
                  value={settings.defaultSection}
                  onChange={(e) =>
                    onUpdateSettings({ defaultSection: e.target.value as NavSection })
                  }
                  className="min-h-[40px] w-full shrink-0 rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none sm:w-auto"
                >
                  <option value="releases">Início</option>
                  <option value="calendar">Calendário</option>
                  <option value="catalog">Catálogo</option>
                  <option value="library">Minha Lista</option>
                </select>
              </div>

              <div className="flex flex-col items-start gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="w-full min-w-0 sm:flex-1">
                  <span className="block text-sm font-medium text-slate-200">
                    Preferência de áudio nos provedores
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Prioriza servidores de vídeo dublados ou legendados quando disponíveis nos provedores.
                  </span>
                </div>
                <div className="grid w-full shrink-0 grid-cols-3 gap-1 rounded-lg border border-white/10 bg-[#151921] p-1 sm:flex sm:w-auto sm:items-center">
                  {(
                    [
                      { id: 'ALL', label: 'Todos' },
                      { id: 'DUB', label: 'Dublados' },
                      { id: 'LEG', label: 'Legendados' },
                    ] as Array<{ id: DefaultAudioFilter; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => onUpdateSettings({ defaultAudioFilter: opt.id })}
                      aria-pressed={settings.defaultAudioFilter === opt.id}
                      className={`min-h-[36px] whitespace-nowrap rounded-md px-3 py-1 text-center text-xs font-medium transition-colors ${
                        settings.defaultAudioFilter === opt.id
                          ? 'bg-[#f97316] text-[#0d0f12]'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col items-start gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <label htmlFor="video-scale-select" className="w-full min-w-0 sm:flex-1">
                  <span className="block text-sm font-medium text-slate-200">
                    Escala de tela padrão
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Define o modo de ajuste do vídeo ao iniciar a reprodução.
                  </span>
                </label>
                <select
                  id="video-scale-select"
                  value={settings.videoScale}
                  onChange={(e) =>
                    onUpdateSettings({ videoScale: e.target.value as VideoScaleMode })
                  }
                  className="min-h-[40px] w-full shrink-0 rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none sm:w-auto"
                >
                  {VIDEO_SCALE_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                <label htmlFor="toggle-autoplay-next" className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-sm font-medium text-slate-200">
                    Avançar automaticamente para o próximo episódio
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Ao terminar o vídeo atual, abre automaticamente o próximo episódio da série.
                  </span>
                </label>
                <ToggleSwitch
                  id="toggle-autoplay-next"
                  checked={settings.autoPlayNextEpisode}
                  onChange={(val) => onUpdateSettings({ autoPlayNextEpisode: val })}
                  label="Avançar automaticamente para o próximo episódio"
                />
              </div>
            </div>

            {/* Backup & Restore (JSON) */}
            <div
              data-backup-section="true"
              className="space-y-3 rounded-xl border border-white/10 bg-[#0d0f12]/70 p-4"
            >
              <div className="space-y-1">
                <span className="block text-sm font-semibold text-slate-200">
                  Backup de dados locais
                </span>
                <span className="block text-xs leading-relaxed text-slate-400">
                  Exporte ou restaure Minha Lista, histórico, episódios assistidos e configurações em JSON.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-backup-export-downloads="true"
                  disabled={exportingBackup !== null}
                  onClick={() => void handleExportBackupClick('downloads')}
                  className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-[#f97316]/45 bg-[#f97316]/12 px-3 py-1.5 text-xs font-semibold text-[#fb923c] transition-colors hover:bg-[#f97316]/20 hover:text-white disabled:opacity-50"
                >
                  {exportingBackup === 'downloads' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                  ) : (
                    <Download className="h-3.5 w-3.5 text-[#f97316]" />
                  )}
                  <span>{isNativeAndroid ? 'Salvar em Downloads' : 'Exportar backup'}</span>
                </button>
                {isNativeAndroid && (
                  <button
                    type="button"
                    data-backup-export-share="true"
                    disabled={exportingBackup !== null}
                    onClick={() => void handleExportBackupClick('share')}
                    className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white disabled:opacity-50"
                  >
                    {exportingBackup === 'share' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                    ) : (
                      <Share2 className="h-3.5 w-3.5 text-[#f97316]" />
                    )}
                    <span>Compartilhar</span>
                  </button>
                )}
                <button
                  type="button"
                  data-backup-import="true"
                  onClick={() => backupFileInputRef.current?.click()}
                  className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
                >
                  <Upload className="h-3.5 w-3.5 text-[#f97316]" />
                  <span>Importar backup</span>
                </button>
                <input
                  ref={backupFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => void handleBackupFileSelected(e)}
                  className="hidden"
                  aria-label="Selecionar arquivo de backup JSON"
                />
              </div>

              {backupError && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  {backupError}
                </div>
              )}

              {pendingBackupImport && (
                <div className="space-y-2.5 rounded-lg border border-[#f97316]/30 bg-[#151921] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-white">
                        Restaurar {pendingBackupImport.filename}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {pendingBackupImport.summary.favoritesCount} favoritos ·{' '}
                        {pendingBackupImport.summary.historyCount} no histórico ·{' '}
                        {pendingBackupImport.summary.progressCount} episódios com progresso
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingBackupImport(null)}
                      aria-label="Cancelar importação"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-[#0d0f12] text-slate-400 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleConfirmBackupImport('merge')}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-[#f97316] px-3 py-1.5 text-xs font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c]"
                    >
                      Mesclar com dados atuais
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmBackupImport('replace')}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/12 px-3 py-1.5 text-xs font-medium text-rose-200 transition-colors hover:border-rose-400 hover:text-white"
                    >
                      Substituir tudo
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Offline Saved Videos Management */}
            <div
              data-offline-downloads-section="true"
              className="space-y-3 rounded-xl border border-white/8 bg-[#0d0f12]/70 p-3.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <HardDrive className="h-4 w-4 shrink-0 text-emerald-400" />
                    <p className="text-sm font-medium text-white">Vídeos salvos offline</p>
                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/12 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-300">
                      {completedOfflineDownloads.length}{' '}
                      {completedOfflineDownloads.length === 1 ? 'vídeo' : 'vídeos'}
                      {totalOfflineBytes > 0 ? ` · ${formatBytes(totalOfflineBytes)}` : ''}
                    </span>
                    {queuedOfflineDownloads.length > 0 && (
                      <span
                        data-offline-queue-badge="true"
                        className="rounded-full border border-amber-400/35 bg-amber-500/12 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300"
                      >
                        {queuedOfflineDownloads.length} na fila
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">
                    Episódios baixados são reproduzidos direto do celular automaticamente, sem
                    gastar internet. Múltiplos downloads rodam em fila (1 por vez) na velocidade máxima.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {onClearOfflineQueue && queuedOfflineDownloads.length > 0 && (
                    <button
                      type="button"
                      data-offline-clear-queue-btn="true"
                      onClick={onClearOfflineQueue}
                      className="inline-flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
                    >
                      <X className="h-3.5 w-3.5 shrink-0" />
                      <span>Limpar fila ({queuedOfflineDownloads.length})</span>
                    </button>
                  )}

                  {onDeleteAllOfflineDownloads && completedOfflineDownloads.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirmClearAllOffline) {
                          setConfirmClearAllOffline(false);
                          onDeleteAllOfflineDownloads();
                        } else {
                          setConfirmClearAllOffline(true);
                        }
                      }}
                      className={`inline-flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        confirmClearAllOffline
                          ? 'border-rose-500/50 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                          : 'border-white/12 bg-[#151921] text-slate-300 hover:border-rose-500/45 hover:text-rose-200'
                      }`}
                    >
                      <Trash2 className="h-3.5 w-3.5 shrink-0" />
                      <span>{confirmClearAllOffline ? 'Confirmar exclusão?' : 'Apagar todos'}</span>
                    </button>
                  )}
                </div>
              </div>

              {engineInfo && (
                <div
                  data-download-engine-info="true"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/8 bg-[#151921]/90 px-3 py-2 text-[11px]"
                >
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-slate-300">
                    <span className="inline-flex items-center gap-1 font-semibold text-[#fb923c]">
                      <Zap className="h-3.5 w-3.5" />
                      {engineInfo.aria2Available
                        ? `aria2c ${engineInfo.aria2Version ? `v${engineInfo.aria2Version}` : ''}`.trim()
                        : 'Acelerador paralelo'}
                    </span>
                    <span className="text-slate-400">
                      {engineInfo.maxConnectionsPerServer} conexões · {engineInfo.maxSplits} partes
                    </span>
                    {engineInfo.ytdlpAvailable && (
                      <span className="text-emerald-300">
                        yt-dlp {engineInfo.ytdlpVersion || 'ativo'}
                      </span>
                    )}
                  </div>
                  {isNativeAndroid && engineInfo.ytdlpAvailable && (
                    <button
                      type="button"
                      data-update-ytdlp-btn="true"
                      disabled={updatingYtDlp}
                      onClick={() => void handleUpdateYtDlpClick()}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-white/12 bg-[#0d0f12] px-2 text-[11px] font-medium text-slate-200 transition-colors hover:border-[#f97316]/50 hover:text-white disabled:opacity-50"
                    >
                      {updatingYtDlp ? (
                        <Loader2 className="h-3 w-3 animate-spin text-[#f97316]" />
                      ) : (
                        <RefreshCw className="h-3 w-3 text-[#f97316]" />
                      )}
                      <span>Atualizar yt-dlp</span>
                    </button>
                  )}
                  {ytDlpStatusMsg && (
                    <p className="w-full text-[11px] text-slate-300">{ytDlpStatusMsg}</p>
                  )}
                </div>
              )}

              {offlineDownloads.length === 0 ? (
                <p className="rounded-lg border border-white/6 bg-[#151921]/70 px-3 py-2.5 text-xs text-slate-400">
                  Nenhum episódio baixado ainda. Toque em <strong className="text-slate-200">Baixar</strong>{' '}
                  no perfil de um anime ou na página do episódio.
                </p>
              ) : (
                <div className="max-h-60 space-y-2 overflow-y-auto pr-0.5">
                  {offlineDownloads.map((item) => {
                    const isQueued = item.status === 'queued';
                    const isBusy =
                      item.status === 'resolving' || item.status === 'downloading';
                    const isDone = item.status === 'completed';
                    return (
                      <div
                        key={item.id}
                        className="flex items-center justify-between gap-2.5 rounded-lg border border-white/8 bg-[#151921] px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-white">
                            {item.seriesTitle || item.title}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                            <span className="truncate">
                              {item.episodeLabel ? `${item.episodeLabel} · ` : ''}
                              {item.title}
                            </span>
                            {isDone && item.sizeBytes > 0 && (
                              <span className="shrink-0 font-mono text-emerald-300">
                                {formatBytes(item.sizeBytes)}
                              </span>
                            )}
                            {isQueued && (
                              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-amber-300">
                                <Clock className="h-3 w-3" />
                                {item.queuePosition
                                  ? `Na fila (#${item.queuePosition})`
                                  : 'Na fila'}
                              </span>
                            )}
                            {isBusy && (
                              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[#fb923c]">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                {item.status === 'resolving'
                                  ? 'Preparando...'
                                  : `${item.progress}%${
                                      item.speedBytesPerSec
                                        ? ` · ${formatDownloadSpeed(item.speedBytesPerSec)}`
                                        : ''
                                    }`}
                              </span>
                            )}
                            {item.status === 'error' && (
                              <span className="shrink-0 text-amber-300">Falhou</span>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          {isDone && onOpenOfflineEpisode && (
                            <button
                              type="button"
                              onClick={() => onOpenOfflineEpisode(item)}
                              aria-label={`Assistir ${item.title} offline`}
                              className="inline-flex h-8 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/25"
                            >
                              <Play className="h-3 w-3 fill-current" />
                              <span>Assistir</span>
                            </button>
                          )}
                          {(isBusy || isQueued) && onCancelOfflineDownload ? (
                            <button
                              type="button"
                              onClick={() => onCancelOfflineDownload(item.id)}
                              aria-label={`Cancelar download de ${item.title}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#0d0f12] text-slate-300 hover:border-rose-500/45 hover:text-rose-300"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          ) : onDeleteOfflineDownload ? (
                            <button
                              type="button"
                              onClick={() => onDeleteOfflineDownload(item.id)}
                              aria-label={`Apagar ${item.title}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#0d0f12] text-slate-400 hover:border-rose-500/45 hover:text-rose-300"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Maintenance / Local Storage Actions */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={historyCount === 0}
                  onClick={onClearHistory}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/10 bg-[#0d0f12] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Limpar histórico ({historyCount})</span>
                </button>
                <button
                  type="button"
                  disabled={alertsCount === 0}
                  onClick={onClearAlerts}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/10 bg-[#0d0f12] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Limpar avisos ({alertsCount})</span>
                </button>
              </div>

              <button
                type="button"
                onClick={onResetSettings}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/10 bg-[#0d0f12] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-white/25 hover:text-white"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Restaurar padrões</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
