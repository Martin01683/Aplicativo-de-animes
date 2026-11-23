import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  Download,
  ExternalLink,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type { RemoteAppRelease } from '../lib/appUpdater';
import {
  filterFavoriteAlerts,
  formatHourLabel,
  type NotificationFilterTab,
  type NotificationPermissionStatus,
} from '../lib/notifications';
import { formatRelativeTimestamp } from '../lib/settings';
import type { FavoriteAlertEntry } from '../lib/types';

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
  alerts: FavoriteAlertEntry[];
  unreadCount: number;
  checkingAlerts: boolean;
  lastEpisodeCheckAt: string | null;
  notificationPermission: NotificationPermissionStatus;
  quietHoursActive: boolean;
  quietHoursEnd: number;
  hasAppUpdate: boolean;
  latestRelease: RemoteAppRelease | null;
  onCheckAlerts: () => void;
  onMarkAllRead: () => void;
  onMarkAlertRead: (alertId: string) => void;
  onDismissAlert: (alertId: string) => void;
  onClearReadAlerts: () => void;
  onOpenAlert: (alert: FavoriteAlertEntry) => void;
  onOpenAlertAnime: (animeUrl: string) => void;
  onRequestPushNotifications: () => void;
  onSendTestNotification: () => void;
  onOpenNotificationSettings: () => void;
  onOpenUpdateSettings: () => void;
  onOpenLibrary: () => void;
}

export function NotificationCenter({
  open,
  onClose,
  alerts,
  unreadCount,
  checkingAlerts,
  lastEpisodeCheckAt,
  notificationPermission,
  quietHoursActive,
  quietHoursEnd,
  hasAppUpdate,
  latestRelease,
  onCheckAlerts,
  onMarkAllRead,
  onMarkAlertRead,
  onDismissAlert,
  onClearReadAlerts,
  onOpenAlert,
  onOpenAlertAnime,
  onRequestPushNotifications,
  onSendTestNotification,
  onOpenNotificationSettings,
  onOpenUpdateSettings,
  onOpenLibrary,
}: NotificationCenterProps) {
  const [activeTab, setActiveTab] = useState<NotificationFilterTab>('all');
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 639px)').matches
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 639px)');
    const sync = () => setIsMobileViewport(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const filteredAlerts = useMemo(() => filterFavoriteAlerts(alerts, activeTab), [alerts, activeTab]);
  const readCount = useMemo(() => alerts.filter((a) => a.read).length, [alerts]);
  const systemCount = hasAppUpdate && latestRelease ? 1 : 0;
  const totalUnread = unreadCount + systemCount;
  const showSystemItem =
    Boolean(hasAppUpdate && latestRelease) &&
    (activeTab === 'all' || activeTab === 'unread' || activeTab === 'system');

  if (!open) return null;

  const tabs: Array<{ id: NotificationFilterTab; label: string; count?: number }> = [
    { id: 'all', label: 'Todas', count: alerts.length + systemCount },
    { id: 'unread', label: 'Não lidas', count: totalUnread },
    { id: 'episodes', label: 'Episódios', count: alerts.length },
    { id: 'system', label: 'Sistema', count: systemCount },
  ];

  const panelBody = (
    <div
      role="dialog"
      aria-label="Central de Notificações"
      className="flex max-h-[82dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-white/15 bg-[#151921] text-[#f1f5f9] shadow-2xl sm:max-h-[560px] sm:w-[410px] sm:rounded-xl"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Mobile grab handle */}
      <div className="flex justify-center pt-2.5 sm:hidden" aria-hidden="true">
        <span className="h-1 w-10 rounded-full bg-white/20" />
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">Notificações</h2>
            {totalUnread > 0 && (
              <span className="text-xs font-medium tabular-nums text-[#fb923c]">
                · {totalUnread} nova{totalUnread === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] tabular-nums text-slate-400">
            Última checagem: {formatRelativeTimestamp(lastEpisodeCheckAt)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={checkingAlerts}
            onClick={onCheckAlerts}
            aria-label="Verificar novos episódios agora"
            className="inline-flex min-h-[34px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-white/12 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white disabled:opacity-50"
          >
            {checkingAlerts ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 text-[#f97316]" />
            )}
            <span>Verificar</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenNotificationSettings();
            }}
            aria-label="Configurar notificações"
            title="Configurar notificações"
            className="flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-white/12 bg-[#0d0f12] text-slate-300 transition-colors hover:border-[#f97316]/60 hover:text-white"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar central de notificações"
            className="flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-white/12 bg-[#0d0f12] text-slate-300 transition-colors hover:border-white/25 hover:text-white sm:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div
        role="tablist"
        aria-label="Filtrar notificações"
        className="grid grid-cols-4 gap-1 border-b border-white/8 bg-[#0d0f12]/55 p-1.5"
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-[34px] whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium tabular-nums transition-colors ${
                active
                  ? 'bg-[#151921] text-white shadow-sm ring-1 ring-white/12'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
              {typeof tab.count === 'number' && tab.count > 0 ? ` (${tab.count})` : ''}
            </button>
          );
        })}
      </div>

      {/* Quiet hours banner */}
      {quietHoursActive && (
        <div className="flex items-center gap-2 border-b border-white/8 bg-indigo-500/10 px-4 py-2 text-[11px] text-indigo-200">
          <Moon className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
          <span>
            Horário silencioso ativo até {formatHourLabel(quietHoursEnd)} — avisos guardados sem som.
          </span>
        </div>
      )}

      {/* Device notification permission strip */}
      {notificationPermission !== 'unsupported' && (
        <div className="border-b border-white/8 bg-[#0d0f12]/40 px-4 py-2.5">
          {notificationPermission === 'granted' ? (
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1.5 text-emerald-300">
                <Bell className="h-3.5 w-3.5" />
                <span>Notificações no dispositivo ativas</span>
              </span>
              <button
                type="button"
                onClick={onSendTestNotification}
                className="whitespace-nowrap rounded-md border border-white/12 bg-[#151921] px-2.5 py-1 text-[11px] font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
              >
                Testar
              </button>
            </div>
          ) : notificationPermission === 'denied' ? (
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <BellOff className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                <span>Bloqueadas no aparelho — avisos continuam aparecendo aqui.</span>
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={onRequestPushNotifications}
              className="flex min-h-[38px] w-full items-center justify-between rounded-lg border border-[#f97316]/40 bg-[#f97316]/12 px-3 py-1.5 text-left text-xs font-medium text-[#fb923c] transition-colors hover:bg-[#f97316]/20"
            >
              <span>Ativar alertas no aparelho / navegador</span>
              <span className="font-semibold">Permitir</span>
            </button>
          )}
        </div>
      )}

      {/* Scrollable Feed */}
      <div className="flex-1 divide-y divide-white/8 overflow-y-auto">
        {showSystemItem && latestRelease && (
          <div className="flex items-start gap-3 bg-[#f97316]/8 px-4 py-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#f97316]/35 bg-[#f97316]/15 text-[#fb923c]">
              <Download className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-white">Nova versão do Anisync</span>
                <span className="font-semibold text-[#fb923c]">· Sistema</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-slate-300">
                {latestRelease.releaseName || latestRelease.tagName} disponível para atualizar
              </p>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenUpdateSettings();
                }}
                className="mt-2 inline-flex min-h-[32px] items-center gap-1.5 rounded-md bg-[#f97316] px-3 py-1 text-[11px] font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c]"
              >
                <Download className="h-3 w-3" />
                <span>Ver atualização</span>
              </button>
            </div>
          </div>
        )}

        {filteredAlerts.length === 0 && !showSystemItem ? (
          <div className="px-6 py-10 text-center">
            <Bell className="mx-auto h-7 w-7 text-slate-600" />
            <p className="mt-2.5 text-xs font-medium text-slate-300">
              {activeTab === 'unread'
                ? 'Você está em dia com todos os avisos.'
                : activeTab === 'system'
                  ? 'Nenhuma atualização pendente do sistema.'
                  : 'Nenhum novo episódio detectado ainda.'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              {activeTab === 'unread'
                ? 'Novos episódios dos seus animes favoritados aparecerão aqui.'
                : activeTab === 'system'
                  ? 'Quando sair uma nova release do Anisync ela aparecerá nesta aba.'
                  : 'Favorite animes pelo coração e clique em Verificar quando quiser checar novidades.'}
            </p>
          </div>
        ) : (
          filteredAlerts.slice(0, 20).map((alert) => {
            const metaItems: string[] = [alert.episodeLabel];
            if (alert.audioType) metaItems.push(alert.audioType);
            metaItems.push(formatRelativeTimestamp(alert.detectedAt));

            return (
              <div
                key={alert.id}
                className={`group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.04] ${
                  alert.read ? 'opacity-75' : 'bg-[#f97316]/[0.06]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAlert(alert);
                  }}
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                >
                  {alert.poster ? (
                    <img
                      src={alert.poster}
                      alt={alert.animeTitle}
                      referrerPolicy="no-referrer"
                      className="h-14 w-10 shrink-0 rounded-md border border-white/10 object-cover"
                    />
                  ) : (
                    <div className="flex h-14 w-10 shrink-0 items-center justify-center rounded-md border border-white/10 bg-[#0d0f12] text-slate-500">
                      <Play className="h-3.5 w-3.5" />
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-white group-hover:text-[#fb923c]">
                        {alert.animeTitle}
                      </span>
                      {!alert.read && (
                        <span className="shrink-0 text-[10px] font-semibold text-[#fb923c]">
                          · Novo
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] font-medium tabular-nums text-slate-300">
                      {metaItems.join(' · ')}
                    </p>
                    <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[#fb923c]">
                      <Play className="h-3 w-3 fill-current" />
                      <span>Assistir episódio</span>
                    </span>
                  </div>
                </button>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex items-center gap-1">
                    {!alert.read && (
                      <button
                        type="button"
                        onClick={() => onMarkAlertRead(alert.id)}
                        aria-label={`Marcar ${alert.animeTitle} ${alert.episodeLabel} como lida`}
                        title="Marcar como lida"
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#0d0f12] text-slate-300 transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {alert.animeUrl && (
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenAlertAnime(alert.animeUrl);
                        }}
                        aria-label={`Abrir página de ${alert.animeTitle}`}
                        title="Abrir página do anime"
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#0d0f12] text-slate-300 transition-colors hover:border-[#f97316]/50 hover:text-white"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDismissAlert(alert.id)}
                      aria-label={`Dispensar aviso de ${alert.animeTitle} ${alert.episodeLabel}`}
                      title="Dispensar aviso"
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-[#0d0f12] text-slate-400 transition-colors hover:border-rose-500/50 hover:text-rose-300"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-[#0d0f12]/70 px-4 py-2.5">
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={onMarkAllRead}
              className="inline-flex min-h-[32px] items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/10"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              <span>Marcar lidas</span>
            </button>
          )}
          {readCount > 0 && (
            <button
              type="button"
              onClick={onClearReadAlerts}
              className="inline-flex min-h-[32px] items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-rose-300"
            >
              <Trash2 className="h-3 w-3" />
              <span>Limpar lidas</span>
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenLibrary();
          }}
          className="min-h-[32px] whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition-colors hover:text-[#f97316]"
        >
          Ver em Minha Lista
        </button>
      </div>
    </div>
  );

  if (isMobileViewport && typeof document !== 'undefined') {
    return createPortal(
      <div
        data-notification-center-portal="true"
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      >
        {panelBody}
      </div>,
      document.body
    );
  }

  return <div className="absolute right-0 mt-2">{panelBody}</div>;
}
