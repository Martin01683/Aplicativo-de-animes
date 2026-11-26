import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, Cast, Settings } from 'lucide-react';
import type { RemoteAppRelease } from '../lib/appUpdater';
import type { NotificationPermissionStatus } from '../lib/notifications';
import type { FavoriteAlertEntry } from '../lib/types';
import { NotificationCenter } from './NotificationCenter';

export type NavSection = 'releases' | 'calendar' | 'catalog' | 'library';

interface HeaderProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  onPrefetchSection?: (section: NavSection) => void;
  onPrefetchSettings?: () => void;
  isBusy?: boolean;
  onGoHome: () => void;
  alerts: FavoriteAlertEntry[];
  unreadCount: number;
  checkingAlerts: boolean;
  lastEpisodeCheckAt: string | null;
  notificationPermission: NotificationPermissionStatus;
  quietHoursActive: boolean;
  quietHoursEnd: number;
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
  hasAppUpdate: boolean;
  latestRelease: RemoteAppRelease | null;
  onOpenSettings: () => void;
  castActive?: boolean;
  castDeviceName?: string;
  onOpenTvCastControls?: () => void;
}

const NAV_ITEMS: Array<{ id: NavSection; label: string }> = [
  { id: 'releases', label: 'Início' },
  { id: 'calendar', label: 'Calendário' },
  { id: 'catalog', label: 'Catálogo' },
  { id: 'library', label: 'Minha Lista' },
];

export function Header({
  activeSection,
  onSelectSection,
  onPrefetchSection,
  onPrefetchSettings,
  isBusy = false,
  onGoHome,
  alerts,
  unreadCount,
  checkingAlerts,
  lastEpisodeCheckAt,
  notificationPermission,
  quietHoursActive,
  quietHoursEnd,
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
  hasAppUpdate,
  latestRelease,
  onOpenSettings,
  castActive = false,
  castDeviceName = '',
  onOpenTvCastControls,
}: HeaderProps) {
  const [openPopover, setOpenPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openPopover) return;
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-notification-center-portal]')) return;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        setOpenPopover(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [openPopover]);

  const totalBadgeCount = unreadCount + (hasAppUpdate && latestRelease ? 1 : 0);

  return (
    <header
      className="sticky top-0 z-40 border-b border-white/10 bg-[#0d0f12]/90 backdrop-blur-md"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={onGoHome}
          className="flex shrink-0 items-center gap-2.5 text-left transition-opacity hover:opacity-90"
        >
          <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border border-[#f97316]/45 bg-[#0e1115] shadow-sm shadow-[#f97316]/30">
            <img
              src="/pwa-192x192.png"
              alt=""
              aria-hidden="true"
              className="h-full w-full object-cover"
            />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-['Outfit'] text-lg font-bold tracking-tight text-white">
              Ani<span className="text-[#f97316]">sync</span>
            </span>
            <span className="text-[11px] font-medium text-slate-400">
              Animes
            </span>
          </span>
        </button>

        <nav
          aria-label="Navegação principal"
          className="hidden items-center gap-1 md:flex"
        >
          {NAV_ITEMS.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectSection(item.id)}
                onMouseEnter={() => onPrefetchSection?.(item.id)}
                onFocus={() => onPrefetchSection?.(item.id)}
                onTouchStart={() => onPrefetchSection?.(item.id)}
                className={`relative shrink-0 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
              >
                {item.label}
                {item.id === 'library' && unreadCount > 0 && (
                  <span className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-[#f97316] px-1.5 py-0.5 text-[10px] font-bold leading-none tabular-nums text-[#0d0f12]">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {castActive && onOpenTvCastControls && (
            <button
              type="button"
              data-header-cast-btn="true"
              onClick={() => {
                setOpenPopover(false);
                onOpenTvCastControls();
              }}
              aria-label={
                castDeviceName
                  ? `Abrir controles da TV (${castDeviceName})`
                  : 'Abrir controles da transmissão na TV'
              }
              title={
                castDeviceName
                  ? `Transmitindo em ${castDeviceName} — abrir controles`
                  : 'Abrir controles da TV'
              }
              className="relative inline-flex h-10 items-center gap-1.5 rounded-lg border border-[#f97316]/60 bg-[#f97316]/15 px-2.5 text-xs font-semibold text-[#fb923c] transition-colors hover:bg-[#f97316]/25 hover:text-white"
            >
              <Cast className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">Na TV</span>
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex h-2.5 w-2.5"
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f97316] opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#f97316]" />
              </span>
            </button>
          )}
          <div ref={popoverRef} className="relative">
            <button
              type="button"
              onClick={() => setOpenPopover((prev) => !prev)}
              aria-expanded={openPopover}
              aria-haspopup="dialog"
              aria-label={
                totalBadgeCount > 0
                  ? `Notificações (${totalBadgeCount} ${totalBadgeCount === 1 ? 'novo aviso' : 'novos avisos'})`
                  : 'Notificações'
              }
              className={`relative flex h-10 w-10 items-center justify-center rounded-lg border transition-colors ${
                openPopover
                  ? 'border-[#f97316]/70 bg-[#151921] text-white'
                  : 'border-white/10 bg-[#151921] text-slate-200 hover:border-[#f97316]/60 hover:text-white'
              }`}
            >
              {totalBadgeCount > 0 ? (
                <BellRing className="h-4.5 w-4.5 text-[#f97316]" />
              ) : (
                <Bell className="h-4.5 w-4.5" />
              )}
              {totalBadgeCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#f97316] px-1 text-[10px] font-bold leading-none tabular-nums text-[#0d0f12]">
                  {totalBadgeCount > 9 ? '9+' : totalBadgeCount}
                </span>
              )}
            </button>

            <NotificationCenter
              open={openPopover}
              onClose={() => setOpenPopover(false)}
              alerts={alerts}
              unreadCount={unreadCount}
              checkingAlerts={checkingAlerts}
              lastEpisodeCheckAt={lastEpisodeCheckAt}
              notificationPermission={notificationPermission}
              quietHoursActive={quietHoursActive}
              quietHoursEnd={quietHoursEnd}
              hasAppUpdate={hasAppUpdate}
              latestRelease={latestRelease}
              onCheckAlerts={onCheckAlerts}
              onMarkAllRead={onMarkAllRead}
              onMarkAlertRead={onMarkAlertRead}
              onDismissAlert={onDismissAlert}
              onClearReadAlerts={onClearReadAlerts}
              onOpenAlert={onOpenAlert}
              onOpenAlertAnime={onOpenAlertAnime}
              onRequestPushNotifications={onRequestPushNotifications}
              onSendTestNotification={onSendTestNotification}
              onOpenNotificationSettings={onOpenNotificationSettings}
              onOpenUpdateSettings={onOpenUpdateSettings}
              onOpenLibrary={() => onSelectSection('library')}
            />
          </div>

          <button
            type="button"
            onClick={() => {
              setOpenPopover(false);
              onOpenSettings();
            }}
            onMouseEnter={() => onPrefetchSettings?.()}
            onFocus={() => onPrefetchSettings?.()}
            onTouchStart={() => onPrefetchSettings?.()}
            aria-label="Abrir configurações do Anisync"
            className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-[#151921] text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
          >
            <Settings className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>
      {/* Whisper-quiet hairline background activity indicator — never blocks navigation */}
      <div
        aria-hidden="true"
        data-testid="header-loading-bar"
        data-page-loading={isBusy ? 'true' : 'false'}
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden transition-opacity duration-200 ${
          isBusy ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {isBusy && (
          <div className="anisync-progress-bar h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-[#f97316] to-transparent" />
        )}
      </div>
    </header>
  );
}
