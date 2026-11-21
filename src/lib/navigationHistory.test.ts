import assert from 'node:assert/strict';
import test from 'node:test';
import {
  popRouteFrame,
  pushRouteFrame,
  resolveBackNavigationStep,
  shouldExitOnDoubleBack,
  type AppRouteFrame,
} from './navigationHistory';

test('pushRouteFrame replaces consecutive episode transitions and avoids anime->episode->anime loops', () => {
  let stack: AppRouteFrame[] = [{ view: 'catalog' }];
  stack = pushRouteFrame(stack, { view: 'anime', url: 'https://topanimes.net/animes/frieren/' });
  stack = pushRouteFrame(stack, {
    view: 'episode',
    url: 'https://topanimes.net/episodio/frieren-episodio-1/',
  });
  stack = pushRouteFrame(stack, {
    view: 'episode',
    url: 'https://topanimes.net/episodio/frieren-episodio-2/',
  });

  assert.equal(stack.length, 3);
  assert.deepEqual(stack[2], {
    view: 'episode',
    url: 'https://topanimes.net/episodio/frieren-episodio-2/',
  });

  // Navigating back to parent anime pops the episode rather than pushing duplicate anime
  stack = pushRouteFrame(stack, { view: 'anime', url: 'https://topanimes.net/animes/frieren' });
  assert.deepEqual(stack, [
    { view: 'catalog' },
    { view: 'anime', url: 'https://topanimes.net/animes/frieren/' },
  ]);
});

test('popRouteFrame steps backwards until root catalog', () => {
  const stack: AppRouteFrame[] = [
    { view: 'catalog' },
    { view: 'anime', url: 'https://topanimes.net/animes/frieren/' },
    { view: 'episode', url: 'https://topanimes.net/episodio/frieren-episodio-2/' },
  ];

  const step1 = popRouteFrame(stack);
  assert.equal(step1.handled, true);
  assert.deepEqual(step1.target, { view: 'anime', url: 'https://topanimes.net/animes/frieren/' });

  const step2 = popRouteFrame(step1.nextStack);
  assert.equal(step2.handled, true);
  assert.deepEqual(step2.target, { view: 'catalog' });

  const step3 = popRouteFrame(step2.nextStack);
  assert.equal(step3.handled, false);
  assert.deepEqual(step3.target, { view: 'catalog' });
});

test('resolveBackNavigationStep prioritizes settings, routes, search, filters, and default tab before root exit', () => {
  assert.equal(
    resolveBackNavigationStep({
      settingsOpen: true,
      routeStack: [{ view: 'catalog' }, { view: 'episode', url: 'https://topanimes.net/ep/1' }],
      hasSearchResults: true,
      hasCatalogFilters: true,
      activeSection: 'catalog',
      defaultSection: 'releases',
    }).type,
    'close-settings'
  );

  assert.equal(
    resolveBackNavigationStep({
      settingsOpen: false,
      routeStack: [{ view: 'catalog' }, { view: 'episode', url: 'https://topanimes.net/ep/1' }],
      hasSearchResults: true,
      hasCatalogFilters: false,
      activeSection: 'releases',
      defaultSection: 'releases',
    }).type,
    'pop-route'
  );

  assert.equal(
    resolveBackNavigationStep({
      settingsOpen: false,
      routeStack: [{ view: 'catalog' }],
      hasSearchResults: true,
      hasCatalogFilters: false,
      activeSection: 'releases',
      defaultSection: 'releases',
    }).type,
    'clear-search'
  );

  assert.equal(
    resolveBackNavigationStep({
      settingsOpen: false,
      routeStack: [{ view: 'catalog' }],
      hasSearchResults: false,
      hasCatalogFilters: true,
      activeSection: 'catalog',
      defaultSection: 'releases',
    }).type,
    'clear-catalog-filters'
  );

  assert.deepEqual(
    resolveBackNavigationStep({
      settingsOpen: false,
      routeStack: [{ view: 'catalog' }],
      hasSearchResults: false,
      hasCatalogFilters: false,
      activeSection: 'catalog',
      defaultSection: 'releases',
    }),
    { type: 'switch-section', section: 'releases' }
  );

  assert.equal(
    resolveBackNavigationStep({
      settingsOpen: false,
      routeStack: [{ view: 'catalog' }],
      hasSearchResults: false,
      hasCatalogFilters: false,
      activeSection: 'releases',
      defaultSection: 'releases',
    }).type,
    'at-root'
  );
});

test('shouldExitOnDoubleBack requires two quick presses within window', () => {
  const first = shouldExitOnDoubleBack(0, 10_000, 2000);
  assert.equal(first.shouldExit, false);
  assert.equal(first.nextLastBackPressedAtMs, 10_000);

  const tooSlow = shouldExitOnDoubleBack(first.nextLastBackPressedAtMs, 12_500, 2000);
  assert.equal(tooSlow.shouldExit, false);
  assert.equal(tooSlow.nextLastBackPressedAtMs, 12_500);

  const quickSecond = shouldExitOnDoubleBack(tooSlow.nextLastBackPressedAtMs, 13_400, 2000);
  assert.equal(quickSecond.shouldExit, true);
  assert.equal(quickSecond.nextLastBackPressedAtMs, 0);
});
