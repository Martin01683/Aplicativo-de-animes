import { isSameEpisodeUrl } from './nativeVlcPlayer';

export type AppRouteFrame =
  | { view: 'catalog' }
  | { view: 'anime'; url: string }
  | { view: 'episode'; url: string };

export function isSameRouteFrame(a: AppRouteFrame, b: AppRouteFrame): boolean {
  if (a.view !== b.view) return false;
  if (a.view === 'catalog') return true;
  if (b.view === 'catalog') return false;
  return isSameEpisodeUrl(a.url, b.url);
}

/**
 * Pushes a new route onto the navigation stack:
 * - Episode -> Episode transitions replace the current episode entry so bingeing
 *   multiple episodes doesn't force the user to press Back through every watched episode.
 * - Navigating from Episode back to its parent Anime pops the Episode entry instead of
 *   creating a [catalog, anime, episode, anime] cycle.
 */
export function pushRouteFrame(
  stack: readonly AppRouteFrame[],
  next: AppRouteFrame
): AppRouteFrame[] {
  if (next.view === 'catalog') {
    return [{ view: 'catalog' }];
  }

  const base = stack.length > 0 ? [...stack] : [{ view: 'catalog' } as AppRouteFrame];
  const top = base[base.length - 1];

  if (isSameRouteFrame(top, next)) {
    return base;
  }

  if (next.view === 'episode' && top.view === 'episode') {
    base[base.length - 1] = next;
    return base;
  }

  if (next.view === 'anime' && top.view === 'episode') {
    const prev = base.length >= 2 ? base[base.length - 2] : null;
    if (prev && isSameRouteFrame(prev, next)) {
      base.pop();
      return base;
    }
  }

  base.push(next);
  return base;
}

export function popRouteFrame(stack: readonly AppRouteFrame[]): {
  handled: boolean;
  nextStack: AppRouteFrame[];
  target: AppRouteFrame;
} {
  if (stack.length <= 1) {
    return {
      handled: false,
      nextStack: [{ view: 'catalog' }],
      target: { view: 'catalog' },
    };
  }
  const nextStack = stack.slice(0, -1);
  return {
    handled: true,
    nextStack,
    target: nextStack[nextStack.length - 1],
  };
}

export type BackNavigationAction =
  | { type: 'close-settings' }
  | { type: 'pop-route'; nextStack: AppRouteFrame[]; target: AppRouteFrame }
  | { type: 'clear-search' }
  | { type: 'clear-catalog-filters' }
  | { type: 'switch-section'; section: string }
  | { type: 'at-root' };

export function resolveBackNavigationStep(state: {
  settingsOpen: boolean;
  routeStack: readonly AppRouteFrame[];
  hasSearchResults: boolean;
  hasCatalogFilters: boolean;
  activeSection: string;
  defaultSection: string;
}): BackNavigationAction {
  if (state.settingsOpen) {
    return { type: 'close-settings' };
  }

  const popped = popRouteFrame(state.routeStack);
  if (popped.handled) {
    return {
      type: 'pop-route',
      nextStack: popped.nextStack,
      target: popped.target,
    };
  }

  if (state.hasSearchResults) {
    return { type: 'clear-search' };
  }

  if (state.activeSection === 'catalog' && state.hasCatalogFilters) {
    return { type: 'clear-catalog-filters' };
  }

  if (state.activeSection !== state.defaultSection) {
    return { type: 'switch-section', section: state.defaultSection };
  }

  return { type: 'at-root' };
}

export function shouldExitOnDoubleBack(
  lastBackPressedAtMs: number,
  nowMs: number,
  windowMs = 2000
): { shouldExit: boolean; nextLastBackPressedAtMs: number } {
  if (lastBackPressedAtMs > 0 && nowMs - lastBackPressedAtMs <= windowMs) {
    return { shouldExit: true, nextLastBackPressedAtMs: 0 };
  }
  return { shouldExit: false, nextLastBackPressedAtMs: nowMs };
}
