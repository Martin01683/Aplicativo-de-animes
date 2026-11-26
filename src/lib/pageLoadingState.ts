import type { NavSection } from '../components/Header';
import type { AnimeDetailLoadingStage } from '../components/AnimeDetailView';

export type ActiveRouteView = 'catalog' | 'anime' | 'episode';

export interface PageLoadingSignals {
  routeView: ActiveRouteView;
  activeSection: NavSection;
  documentLoading: boolean;
  routeChunkLoading: boolean;
  loadingCatalog: boolean;
  loadingInitialReleases: boolean;
  loadingMoreReleases: boolean;
  loadingWeeklyCalendar: boolean;
  weeklyCalendarInitialized: boolean;
  hasCalendarError: boolean;
  loadingArchiveCategory: boolean;
  archiveCategoryInitialized: boolean;
  hasActiveCatalogFilter: boolean;
  loadingFilteredCatalog: boolean;
  searching: boolean;
  loadingMoreSearch: boolean;
  loadingRandom: boolean;
  loadingDetail: boolean;
  animeDetailStage: AnimeDetailLoadingStage;
  animeViewHydrating: boolean;
  loadingExtraServers: boolean;
  episodeViewLoading: boolean;
  pendingVisibleImages: boolean;
}

export interface ImageElementSnapshot {
  hasSrc: boolean;
  complete: boolean;
  loadingAttr: string;
  hidden: boolean;
  rect: {
    top: number;
    bottom: number;
    width: number;
    height: number;
  };
}

export const PAGE_LOADING_SETTLE_MS = 220;
export const PAGE_IMAGE_WAIT_TIMEOUT_MS = 5000;
const LAZY_VIEWPORT_BUFFER_PX = 120;

/**
 * Determines whether the currently displayed page still has any pending
 * primary, secondary, or visual loading work. The header loading bar should
 * only disappear once this returns `false` and stays settled.
 */
export function isActivePageLoading(signals: PageLoadingSignals): boolean {
  if (
    signals.documentLoading ||
    signals.routeChunkLoading ||
    signals.loadingRandom ||
    signals.pendingVisibleImages
  ) {
    return true;
  }

  if (signals.routeView === 'anime') {
    return (
      signals.loadingDetail ||
      signals.animeDetailStage === 'seed' ||
      signals.animeDetailStage === 'quick' ||
      signals.animeViewHydrating
    );
  }

  if (signals.routeView === 'episode') {
    return (
      signals.loadingDetail ||
      signals.loadingExtraServers ||
      signals.episodeViewLoading
    );
  }

  // Catalog / main shell views
  if (signals.searching || signals.loadingMoreSearch) {
    return true;
  }

  switch (signals.activeSection) {
    case 'releases':
      return (
        signals.loadingCatalog ||
        signals.loadingInitialReleases ||
        signals.loadingMoreReleases
      );
    case 'calendar':
      return (
        signals.loadingWeeklyCalendar ||
        (!signals.weeklyCalendarInitialized && !signals.hasCalendarError)
      );
    case 'catalog':
      if (signals.hasActiveCatalogFilter) {
        return signals.loadingFilteredCatalog;
      }
      return (
        signals.loadingArchiveCategory ||
        !signals.archiveCategoryInitialized
      );
    case 'library':
      return false;
    default:
      return false;
  }
}

/**
 * Returns true if an `<img>` element in the active page should keep the
 * header loading bar active until it finishes loading (or fails).
 * Offscreen `loading="lazy"` images are excluded so tall pages never hang.
 */
export function shouldWaitForImage(
  img: ImageElementSnapshot,
  viewportHeight: number
): boolean {
  if (!img.hasSrc || img.complete || img.hidden) {
    return false;
  }
  if (img.rect.width <= 0 && img.rect.height <= 0) {
    return false;
  }
  if (img.loadingAttr !== 'lazy') {
    return true;
  }
  return (
    img.rect.bottom >= -LAZY_VIEWPORT_BUFFER_PX &&
    img.rect.top <= viewportHeight + LAZY_VIEWPORT_BUFFER_PX
  );
}
