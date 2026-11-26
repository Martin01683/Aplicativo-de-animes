import { Bookmark, Calendar, Film, Flame } from 'lucide-react';
import type { NavSection } from './Header';

interface MobileTabBarProps {
  activeSection: NavSection;
  unreadCount?: number;
  onSelectSection: (section: NavSection) => void;
  onPrefetchSection?: (section: NavSection) => void;
}

const MOBILE_TABS: Array<{ id: NavSection; label: string; icon: typeof Flame }> = [
  { id: 'releases', label: 'Início', icon: Flame },
  { id: 'calendar', label: 'Calendário', icon: Calendar },
  { id: 'catalog', label: 'Catálogo', icon: Film },
  { id: 'library', label: 'Lista', icon: Bookmark },
];

export function MobileTabBar({
  activeSection,
  unreadCount = 0,
  onSelectSection,
  onPrefetchSection,
}: MobileTabBarProps) {
  return (
    <nav
      aria-label="Navegação mobile"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/10 bg-[#0d0f12]/95 backdrop-blur-lg md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="grid grid-cols-4">
        {MOBILE_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeSection === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectSection(tab.id)}
              onTouchStart={() => onPrefetchSection?.(tab.id)}
              onMouseEnter={() => onPrefetchSection?.(tab.id)}
              onFocus={() => onPrefetchSection?.(tab.id)}
              className={`relative flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 py-2 text-[11px] font-medium transition-colors ${
                active ? 'text-[#f97316]' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="relative">
                <Icon className="h-5 w-5" />
                {tab.id === 'library' && unreadCount > 0 && (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#f97316] px-1 text-[9px] font-bold leading-none text-[#0d0f12] tabular-nums">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

