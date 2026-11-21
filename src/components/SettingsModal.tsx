import { useEffect } from 'react';
import {
  Bell,
  CheckCircle2,
  Download,
  ExternalLink,
  Film,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type { ApkDownloadProgressEvent } from '../lib/apiClient';
import {
  formatBytes,
  formatShortSha,
  GITHUB_RELEASES_PAGE_URL,
  type AppBuildInfo,
  type AppUpdateCheckResult,
} from '../lib/appUpdater';
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
import type { NavSection } from './Header';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  settingsMeta: AppSettingsMeta;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onResetSettings: () => void;
  // News & episode checking
  favoritesCount: number;
  checkingEpisodes: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  onCheckEpisodesNow: () => void;
  onRequestPushNotifications: () => void;
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
  onApplySwUpdate: () => void;
  // Local data actions
  historyCount: number;
  alertsCount: number;
  onClearHistory: () => void;
  onClearAlerts: () => void;
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
  onClose,
  settings,
  settingsMeta,
  onUpdateSettings,
  onResetSettings,
  favoritesCount,
  checkingEpisodes,
  notificationPermission,
  onCheckEpisodesNow,
  onRequestPushNotifications,
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
  onApplySwUpdate,
  historyCount,
  alertsCount,
  onClearHistory,
  onClearAlerts,
}: SettingsModalProps) {
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
              Configurações do Aplicativo
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Frequência de busca, atualizações do GitHub e preferências de reprodução
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
          {/* 1. Frequência de Busca de Novidades */}
          <section aria-labelledby="settings-news-heading" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2.5">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-[#f97316]" />
                <h3 id="settings-news-heading" className="text-base font-semibold text-white">
                  Frequência de Busca de Novidades
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
                Define de quanto em quanto tempo o aplicativo consulta o catálogo e os animes favoritados para detectar episódios recém-lançados.
              </p>
              <div className="grid grid-cols-3 gap-2 pt-1 sm:grid-cols-6">
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
                    Checa automaticamente se há episódios novos assim que o catálogo carregar.
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
                      ? 'Permissão concedida no navegador/aparelho.'
                      : notificationPermission === 'denied'
                        ? 'Bloqueada no navegador — os avisos continuam visíveis no sininho.'
                        : notificationPermission === 'unsupported'
                          ? 'Alertas exibidos no sininho dentro do aplicativo.'
                          : 'Ative para receber alertas mesmo em segundo plano.'}
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
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-400">
                Atualiza o catálogo e verifica os favoritos imediatamente.
              </span>
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

          {/* 2. Atualizações do Sistema (GitHub Releases) */}
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
                      ? 'Baixa o TopAnimes.apk oficial no app, verifica SHA-256 e assinatura e inicia o instalador do sistema.'
                      : 'Inicia automaticamente o download do novo TopAnimes.apk publicado no GitHub.'}
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
            <div className="space-y-3 rounded-xl border border-white/10 bg-[#0d0f12]/70 p-4">
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
                        <p className="line-clamp-3 text-xs leading-relaxed text-slate-400">
                          {latestRelease.notes}
                        </p>
                      )}

                      {(downloadingAppUpdate || apkDownloadProgress) && (
                        <div className="space-y-1.5 rounded-lg border border-white/8 bg-[#151921] p-3">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-slate-200">
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
                            {apkDownloadProgress && apkDownloadProgress.downloadedBytes > 0 && (
                              <span className="font-mono tabular-nums text-slate-400">
                                {formatBytes(apkDownloadProgress.downloadedBytes)}
                                {apkDownloadProgress.totalBytes > 0
                                  ? ` / ${formatBytes(apkDownloadProgress.totalBytes)}`
                                  : ''}
                              </span>
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

          {/* 3. Catálogo, Player e Dados Locais */}
          <section aria-labelledby="settings-player-heading" className="space-y-4">
            <div className="flex items-center gap-2 border-b border-white/8 pb-2.5">
              <Film className="h-4 w-4 text-[#f97316]" />
              <h3 id="settings-player-heading" className="text-base font-semibold text-white">
                Catálogo e Reprodução
              </h3>
            </div>

            <div className="divide-y divide-white/8 rounded-xl border border-white/10 bg-[#0d0f12]/70">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                <label htmlFor="default-section-select" className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-200">
                    Aba inicial ao abrir o aplicativo
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
                  className="min-h-[40px] rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none"
                >
                  <option value="releases">Lançamentos</option>
                  <option value="calendar">Calendário</option>
                  <option value="catalog">Animes &amp; Filmes</option>
                  <option value="library">Minha Lista</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-200">
                    Filtro padrão de áudio em Lançamentos
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    Filtra automaticamente os episódios exibidos na tela inicial.
                  </span>
                </div>
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#151921] p-1">
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
                      className={`min-h-[34px] whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors ${
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

              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                <label htmlFor="video-scale-select" className="min-w-0 flex-1">
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
                  className="min-h-[40px] rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none"
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
                    Ao terminar o vídeo atual no player web, abre o próximo episódio da série.
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
