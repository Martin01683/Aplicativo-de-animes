import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isActivePageLoading,
  shouldWaitForImage,
  type PageLoadingSignals,
} from './pageLoadingState';

function makeIdleSignals(overrides: Partial<PageLoadingSignals> = {}): PageLoadingSignals {
  return {
    routeView: 'catalog',
    activeSection: 'releases',
    documentLoading: false,
    routeChunkLoading: false,
    loadingCatalog: false,
    loadingInitialReleases: false,
    loadingMoreReleases: false,
    loadingWeeklyCalendar: false,
    weeklyCalendarInitialized: true,
    hasCalendarError: false,
    loadingArchiveCategory: false,
    archiveCategoryInitialized: true,
    hasActiveCatalogFilter: false,
    loadingFilteredCatalog: false,
    searching: false,
    loadingMoreSearch: false,
    loadingRandom: false,
    loadingDetail: false,
    animeDetailStage: 'ready',
    animeViewHydrating: false,
    loadingExtraServers: false,
    episodeViewLoading: false,
    pendingVisibleImages: false,
    ...overrides,
  };
}

test('returns false when the active page is completely loaded', () => {
  assert.equal(isActivePageLoading(makeIdleSignals()), false);
  assert.equal(isActivePageLoading(makeIdleSignals({ routeView: 'anime' })), false);
  assert.equal(isActivePageLoading(makeIdleSignals({ routeView: 'episode' })), false);
});

test('stays true on global document, chunk, random, or visible image loading', () => {
  assert.equal(isActivePageLoading(makeIdleSignals({ documentLoading: true })), true);
  assert.equal(isActivePageLoading(makeIdleSignals({ routeChunkLoading: true })), true);
  assert.equal(isActivePageLoading(makeIdleSignals({ loadingRandom: true })), true);
  assert.equal(isActivePageLoading(makeIdleSignals({ pendingVisibleImages: true })), true);
});

test('releases section stays loading until both home catalog and initial releases finish', () => {
  assert.equal(isActivePageLoading(makeIdleSignals({ loadingCatalog: true })), true);
  assert.equal(
    isActivePageLoading(makeIdleSignals({ loadingCatalog: false, loadingInitialReleases: true })),
    true
  );
  assert.equal(isActivePageLoading(makeIdleSignals({ loadingMoreReleases: true })), true);
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({
        loadingCatalog: false,
        loadingInitialReleases: false,
        loadingMoreReleases: false,
      })
    ),
    false
  );
});

test('calendar section stays loading while fetching or awaiting initialization without error', () => {
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({ activeSection: 'calendar', loadingWeeklyCalendar: true })
    ),
    true
  );
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({
        activeSection: 'calendar',
        weeklyCalendarInitialized: false,
        hasCalendarError: false,
      })
    ),
    true
  );
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({
        activeSection: 'calendar',
        weeklyCalendarInitialized: false,
        hasCalendarError: true,
      })
    ),
    false
  );
  // Background calendar loading should not keep releases section busy
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({ activeSection: 'releases', loadingWeeklyCalendar: true })
    ),
    false
  );
});

test('catalog section stays loading for archive and filtered queries until ready', () => {
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({ activeSection: 'catalog', loadingArchiveCategory: true })
    ),
    true
  );
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({ activeSection: 'catalog', archiveCategoryInitialized: false })
    ),
    true
  );
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({
        activeSection: 'catalog',
        hasActiveCatalogFilter: true,
        loadingFilteredCatalog: true,
      })
    ),
    true
  );
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({
        activeSection: 'catalog',
        hasActiveCatalogFilter: true,
        loadingFilteredCatalog: false,
        archiveCategoryInitialized: false,
      })
    ),
    false
  );
});

test('anime detail page stays loading across quick stage, full details, synopsis, and episode titles', () => {
  assert.equal(
    isActivePageLoading(makeIdleSignals({ routeView: 'anime', loadingDetail: true })),
    true
  );
  assert.equal(
    isActivePageLoading(makeIdleSignals({ routeView: 'anime', animeDetailStage: 'seed' })),
    true
  );
  assert.equal(
    isActivePageLoading(makeIdleSignals({ routeView: 'anime', animeDetailStage: 'quick' })),
    true
  );
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({
        routeView: 'anime',
        loadingDetail: false,
        animeDetailStage: 'ready',
        animeViewHydrating: true,
      })
    ),
    true
  );
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({
        routeView: 'anime',
        loadingDetail: false,
        animeDetailStage: 'ready',
        animeViewHydrating: false,
      })
    ),
    false
  );
});

test('episode page stays loading until details, extra servers, series list, synopsis, and embed finish', () => {
  assert.equal(
    isActivePageLoading(makeIdleSignals({ routeView: 'episode', loadingDetail: true })),
    true
  );
  assert.equal(
    isActivePageLoading(makeIdleSignals({ routeView: 'episode', loadingExtraServers: true })),
    true
  );
  assert.equal(
    isActivePageLoading(makeIdleSignals({ routeView: 'episode', episodeViewLoading: true })),
    true
  );
  assert.equal(
    isActivePageLoading(
      makeIdleSignals({
        routeView: 'episode',
        loadingDetail: false,
        loadingExtraServers: false,
        episodeViewLoading: false,
      })
    ),
    false
  );
});

test('shouldWaitForImage waits for eager and in-viewport lazy images, ignoring hidden or offscreen lazy ones', () => {
  const viewportHeight = 900;

  // Completed image: do not wait
  assert.equal(
    shouldWaitForImage(
      {
        hasSrc: true,
        complete: true,
        loadingAttr: 'eager',
        hidden: false,
        rect: { top: 50, bottom: 250, width: 200, height: 200 },
      },
      viewportHeight
    ),
    false
  );

  // Hidden / collapsed image (e.g. inside kept-alive hidden catalog): do not wait
  assert.equal(
    shouldWaitForImage(
      {
        hasSrc: true,
        complete: false,
        loadingAttr: 'eager',
        hidden: true,
        rect: { top: 0, bottom: 0, width: 0, height: 0 },
      },
      viewportHeight
    ),
    false
  );

  // Eager image still loading: wait
  assert.equal(
    shouldWaitForImage(
      {
        hasSrc: true,
        complete: false,
        loadingAttr: 'eager',
        hidden: false,
        rect: { top: 100, bottom: 400, width: 300, height: 300 },
      },
      viewportHeight
    ),
    true
  );

  // Lazy image inside viewport: wait
  assert.equal(
    shouldWaitForImage(
      {
        hasSrc: true,
        complete: false,
        loadingAttr: 'lazy',
        hidden: false,
        rect: { top: 300, bottom: 600, width: 200, height: 300 },
      },
      viewportHeight
    ),
    true
  );

  // Lazy image far below viewport: do not wait (browser defers loading until scroll)
  assert.equal(
    shouldWaitForImage(
      {
        hasSrc: true,
        complete: false,
        loadingAttr: 'lazy',
        hidden: false,
        rect: { top: 2200, bottom: 2500, width: 200, height: 300 },
      },
      viewportHeight
    ),
    false
  );
});
