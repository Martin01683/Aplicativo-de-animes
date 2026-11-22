import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, CheckCheck, Loader2, RefreshCw, Settings } from 'lucide-react';
import type { FavoriteAlertEntry } from '../lib/types';

export type NavSection = 'releases' | 'calendar' | 'catalog' | 'library';

interface HeaderProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  onGoHome: () => void;
  alerts: FavoriteAlertEntry[];
  unreadCount: number;
  checkingAlerts: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  onCheckAlerts: () => void;
  onMarkAllRead: () => void;
  onOpenAlert: (alert: FavoriteAlertEntry) => void;
  onRequestPushNotifications: () => void;
  hasAppUpdate: boolean;
  onOpenSettings: () => void;
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
  onGoHome,
  alerts,
  unreadCount,
  checkingAlerts,
  notificationPermission,
  onCheckAlerts,
  onMarkAllRead,
  onOpenAlert,
  onRequestPushNotifications,
  hasAppUpdate,
  onOpenSettings,
}: HeaderProps) {
  const [openPopover, setOpenPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openPopover) return;
    const handleOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenPopover(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [openPopover]);

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
                className={`relative whitespace-nowrap shrink-0 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
              >
                {item.label}
                {item.id === 'library' && unreadCount > 0 && (
                  <span className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-[#f97316] px-1.5 py-0.5 text-[10px] font-bold leading-none text-[#0d0f12] tabular-nums">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <div ref={popoverRef} className="relative">
            <button
              type="button"
              onClick={() => setOpenPopover((prev) => !prev)}
              aria-expanded={openPopover}
              aria-label={
                unreadCount > 0
                  ? `Notificações (${unreadCount} novos episódios)`
                  : 'Notificações de novos episódios'
              }
              className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-[#151921] text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
            >
              {unreadCount > 0 ? (
                <BellRing className="h-4.5 w-4.5 text-[#f97316]" />
              ) : (
                <Bell className="h-4.5 w-4.5" />
              )}
              {unreadCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#f97316] px-1 text-[10px] font-bold leading-none text-[#0d0f12] tabular-nums">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {openPopover && (
              <div className="absolute right-0 mt-2 w-[320px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-white/15 bg-[#151921] shadow-2xl sm:w-[360px]">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">
                      Novos Episódios
                    </h2>
                    <p className="text-[11px] text-slate-400">
                      Avisos dos títulos favoritados
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={checkingAlerts}
                      onClick={onCheckAlerts}
                      aria-label="Verificar novos episódios"
                      className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-[#0d0f12] px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-[#f97316]/50 hover:text-white disabled:opacity-50"
                    >
                      {checkingAlerts ? (
                        <Loader2 className="h-3 w-3 animate-spin text-[#f97316]" />
                      ) : (
                        <RefreshCw className="h-3 w-3 text-[#f97316]" />
                      )}
                      <span>Verificar</span>
                    </button>
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={onMarkAllRead}
                        aria-label="Marcar notificações como lidas"
                        className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-[#0d0f12] px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-white"
                      >
                        <CheckCheck className="h-3 w-3 text-emerald-400" />
                        <span>Lidas</span>
                      </button>
                    )}
                  </div>
                </div>

                {notificationPermission !== 'unsupported' && (
                  <div className="border-b border-white/8 bg-[#0d0f12]/60 px-4 py-2.5">
                    {notificationPermission === 'granted' ? (
                      <div className="flex items-center justify-between text-[11px] text-emerald-300">
                        <span>Notificações no aparelho ativas</span>
                        <span className="font-semibold">Ativado</span>
                      </div>
                    ) : notificationPermission === 'denied' ? (
                      <p className="text-[11px] text-slate-400">
                        Notificações bloqueadas nas configurações do navegador. Alertas continuam aparecendo aqui.
                      </p>
                    ) : (
                      <button
                        type="button"
                        onClick={onRequestPushNotifications}
                        className="flex w-full items-center justify-between rounded-lg border border-[#f97316]/35 bg-[#f97316]/10 px-3 py-1.5 text-left text-xs font-medium text-[#fb923c] transition-colors hover:bg-[#f97316]/20"
                      >
                        <span>Ativar alertas no celular / navegador</span>
                        <span className="font-semibold">Ativar</span>
                      </button>
                    )}
                  </div>
                )}

                <div className="max-h-80 divide-y divide-white/8 overflow-y-auto">
                  {alerts.length === 0 ? (
                    <div className="px-4 py-7 text-center text-xs leading-relaxed text-slate-400">
                      Nenhum novo episódio detectado ainda. Favorite seus animes e toque em Verificar quando quiser atualizar.
                    </div>
                  ) : (
                    alerts.slice(0, 8).map((alert) => (
                      <button
                        key={alert.id}
                        type="button"
                        onClick={() => {
                          setOpenPopover(false);
                          onOpenAlert(alert);
                        }}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 ${
                          alert.read ? 'opacity-75' : 'bg-[#f97316]/5'
                        }`}
                      >
                        {alert.poster ? (
                          <img
                            src={alert.poster}
                            alt={alert.animeTitle}
                            className="h-12 w-9 shrink-0 rounded object-cover"
                          />
                        ) : (
                          <div className="h-12 w-9 shrink-0 rounded bg-white/10" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {!alert.read && (
                              <span className="h-2 w-2 shrink-0 rounded-full bg-[#f97316]" />
                            )}
                            <span className="truncate text-xs font-semibold text-white">
                              {alert.animeTitle}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-[11px] font-medium text-[#fb923c]">
                            {alert.episodeLabel} disponível
                          </div>
                        </div>
                        <span className="shrink-0 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white">
                          Assistir
                        </span>
                      </button>
                    ))
                  )}
                </div>

                <div className="border-t border-white/10 bg-[#0d0f12]/60 px-4 py-2 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenPopover(false);
                      onSelectSection('library');
                    }}
                    className="text-xs font-medium text-slate-300 hover:text-[#f97316]"
                  >
                    Ver tudo em Minha Lista
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setOpenPopover(false);
              onOpenSettings();
            }}
            aria-label={
              hasAppUpdate
                ? 'Abrir configurações do Anisync (nova atualização disponível)'
                : 'Abrir configurações do Anisync'
            }
            className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-[#151921] text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
          >
            <Settings className="h-4.5 w-4.5" />
            {hasAppUpdate && (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0d0f12] bg-[#f97316]"
              />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
