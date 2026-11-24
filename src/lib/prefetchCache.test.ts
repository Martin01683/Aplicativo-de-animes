import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildOptimisticAnimeDetails,
  buildOptimisticEpisodeDetails,
  buildSeedFromAnimeEpisode,
  canBackgroundPrefetch,
  clearPersistedSwrSnapshot,
  clearPrefetchCaches,
  getCachedAnimeSynopsis,
  getCachedEpisodeSynopsis,
  isSwrDataFresh,
  loadPersistedSwrSnapshot,
  persistSwrArchive,
  persistSwrCalendar,
  persistSwrHome,
  persistSwrReleases,
  readCachedEpisodeTitles,
  scheduleBackgroundPrefetch,
  setCachedAnimeSynopsis,
  setCachedEpisodeSynopsis,
  writeCachedEpisodeTitles,
} from './prefetchCache';
import type { AnimeDetails, AnimeEpisodeLink, HomeCatalog } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe('prefetchCache SWR persistence, queue, optimistic shells & shared caches', () => {
  it('persists and hydrates SWR snapshot for home, releases, calendar, and archives', () => {
    const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const mockStorage = createMockStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      configurable: true,
      writable: true,
    });

    try {
      clearPersistedSwrSnapshot();
      assert.equal(loadPersistedSwrSnapshot(), null);

      const sampleHome: HomeCatalog = {
        sourceMode: 'live',
        fetchedAt: new Date().toISOString(),
        calendar: [],
        releases: [
          {
            id: 'ep-1',
            title: 'Frieren Ep 1',
            url: 'https://topanimes.net/episodio/frieren-episodio-1/',
            kind: 'episode',
            poster: 'https://img.example.org/ep1.jpg',
            audioType: 'LEG',
          },
        ],
        animes: [
          {
            id: 'a-1',
            title: 'Sousou no Frieren',
            url: 'https://topanimes.net/animes/sousou-no-frieren/',
            kind: 'anime',
            poster: 'https://img.example.org/frieren.jpg',
            audioType: 'LEG',
          },
        ],
        movies: [],
      };

      persistSwrHome(sampleHome);
      persistSwrReleases(sampleHome.releases, 1, 12);
      persistSwrCalendar('streams', [
        { id: 'hoje', label: 'Hoje', isToday: true, items: sampleHome.animes },
      ]);
      persistSwrArchive('animes', {
        sourceMode: 'live',
        currentPage: 1,
        totalPages: 25,
        items: sampleHome.animes,
        featured: sampleHome.animes,
        filters: {
          genres: [{ slug: 'acao', label: 'Ação', url: 'https://topanimes.net/genero/acao/' }],
          years: [{ slug: '2026', label: '2026', url: 'https://topanimes.net/ano/2026/' }],
          types: [],
        },
      });

      const snap = loadPersistedSwrSnapshot();
      assert.ok(snap, 'expected persisted SWR snapshot');
      assert.equal(snap.home?.data.animes[0].title, 'Sousou no Frieren');
      assert.equal(snap.releases?.totalPages, 12);
      assert.equal(snap.calendar?.streams?.days[0].id, 'hoje');
      assert.equal(snap.archive?.animes?.totalPages, 25);
      assert.equal(snap.featuredAnimes?.length, 1);
      assert.equal(snap.catalogFilters?.genres[0].slug, 'acao');
      assert.equal(isSwrDataFresh(snap.home?.fetchedAtMs), true);
      assert.equal(isSwrDataFresh(Date.now() - 10 * 60 * 1000, 2 * 60 * 1000), false);

      // Expired (>24h) snapshots should be discarded automatically
      clearPersistedSwrSnapshot();
      mockStorage.setItem(
        'anisync:swr_snapshot:v1',
        JSON.stringify({
          version: 1,
          savedAt: Date.now() - 30 * 60 * 60 * 1000,
          home: { data: sampleHome, fetchedAtMs: Date.now() - 30 * 60 * 60 * 1000 },
        })
      );
      assert.equal(loadPersistedSwrSnapshot(), null);
      assert.equal(mockStorage.getItem('anisync:swr_snapshot:v1'), null);
    } finally {
      clearPersistedSwrSnapshot();
      if (prevStorage) {
        Object.defineProperty(globalThis, 'localStorage', prevStorage);
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      }
    }
  });

  it('caps background prefetch concurrency to 2, deduplicates keys, and evicts stale queued tasks', async () => {
    let active = 0;
    let peakActive = 0;
    const executed: string[] = [];
    const resolvers: Array<() => void> = [];

    const makeDeferredTask = (label: string) => () =>
      new Promise<void>((resolve) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        executed.push(label);
        resolvers.push(() => {
          active -= 1;
          resolve();
        });
      });

    // Queue 14 unique tasks + 2 duplicates: 2 start immediately, queue holds at most 10 newest
    for (let i = 1; i <= 14; i++) {
      scheduleBackgroundPrefetch(`bg-task-${i}`, makeDeferredTask(`t${i}`), {
        intentTriggered: true,
      });
    }
    // Duplicate of active task & queued task should be ignored
    scheduleBackgroundPrefetch('bg-task-1', makeDeferredTask('dup1'), { intentTriggered: true });
    scheduleBackgroundPrefetch('bg-task-14', makeDeferredTask('dup14'), { intentTriggered: true });

    await Promise.resolve();
    assert.equal(peakActive, 2, 'at most 2 background prefetches may run concurrently');

    // Drain all deferred tasks
    while (resolvers.length > 0) {
      const next = resolvers.shift();
      next?.();
      await new Promise((r) => setTimeout(r, 0));
    }

    assert.equal(peakActive, 2);
    assert.ok(!executed.includes('dup1'), 'active duplicate key must be deduplicated');
    assert.ok(!executed.includes('dup14'), 'queued duplicate key must be deduplicated');
    // Tasks 1 & 2 ran immediately; tasks 3 & 4 were evicted from the 10-slot queue when 13 & 14 arrived
    assert.ok(executed.includes('t1') && executed.includes('t2'));
    assert.ok(executed.includes('t14'), 'most recent intent task must be preserved');
    assert.ok(!executed.includes('t3'), 'oldest queued task should be evicted when queue overflows');
  });

  it('gates background prefetching based on online status, saveData, and 2g connection', () => {
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: false },
        configurable: true,
      });
      assert.equal(canBackgroundPrefetch(), false);
      assert.equal(canBackgroundPrefetch({ intentTriggered: true }), false);

      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: true, connection: { saveData: true, effectiveType: '4g' } },
        configurable: true,
      });
      assert.equal(canBackgroundPrefetch(), false);
      assert.equal(canBackgroundPrefetch({ intentTriggered: true }), false);

      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: true, connection: { saveData: false, effectiveType: '2g' } },
        configurable: true,
      });
      assert.equal(canBackgroundPrefetch({ intentTriggered: false }), false);
      assert.equal(canBackgroundPrefetch({ intentTriggered: true }), true);

      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: true, connection: { saveData: false, effectiveType: '4g' } },
        configurable: true,
      });
      assert.equal(canBackgroundPrefetch(), true);
    } finally {
      if (prevNav) {
        Object.defineProperty(globalThis, 'navigator', prevNav);
      } else {
        delete (globalThis as { navigator?: Navigator }).navigator;
      }
    }
  });

  it('builds optimistic anime and episode shells and skips unavailable adjacent links in seeds', () => {
    assert.equal(buildOptimisticAnimeDetails('https://topanimes.net/animes/x/', null), null);

    const animeShell = buildOptimisticAnimeDetails(
      'https://topanimes.net/animes/sousou-no-frieren/',
      {
        title: 'Sousou no Frieren',
        poster: 'https://img.example.org/frieren.jpg',
        kind: 'anime',
        audioType: 'LEG',
        year: '2023',
        rating: '9.1',
      }
    );
    assert.ok(animeShell);
    assert.equal(animeShell.title, 'Sousou no Frieren');
    assert.equal(animeShell.audioType, 'LEG');
    assert.deepEqual(animeShell.episodes, []);

    const episodes: AnimeEpisodeLink[] = [
      {
        title: 'Ep 1',
        url: 'https://topanimes.net/episodio/frieren-episodio-1/',
        numberLabel: '1x1',
        seasonNumber: 1,
        episodeNumber: 1,
        thumb: 'https://img.example.org/ep1.jpg',
        availableOnServer: true,
      },
      {
        title: 'Ep 2',
        url: 'https://topanimes.net/episodio/frieren-episodio-2/',
        numberLabel: '1x2',
        seasonNumber: 1,
        episodeNumber: 2,
        thumb: 'https://img.example.org/ep2.jpg',
        availableOnServer: true,
      },
      {
        title: 'Ep 3 (Scheduled)',
        url: 'anisync://upcoming/3',
        numberLabel: '1x3',
        seasonNumber: 1,
        episodeNumber: 3,
        availableOnServer: false,
      },
    ];
    const fullAnime: AnimeDetails = {
      ...animeShell,
      episodes,
    };

    const seedEp2 = buildSeedFromAnimeEpisode(fullAnime, episodes[1], episodes);
    assert.equal(seedEp2.prevUrl, episodes[0].url);
    assert.equal(seedEp2.nextUrl, undefined, 'unavailable upcoming episode must not be set as nextUrl');
    assert.equal(seedEp2.backdrop, 'https://img.example.org/ep2.jpg');

    const epShell = buildOptimisticEpisodeDetails(episodes[1].url, seedEp2, fullAnime);
    assert.ok(epShell);
    assert.equal(epShell.seriesTitle, 'Sousou no Frieren');
    assert.equal(epShell.prevUrl, episodes[0].url);
    assert.equal(epShell.backdrop, 'https://img.example.org/ep2.jpg');
    assert.deepEqual(epShell.options, []);
  });

  it('persists shared episode title hydration and synopsis caches across component mounts', () => {
    clearPrefetchCaches('all');

    writeCachedEpisodeTitles({ 101: 'O Fim da Jornada' }, [101, 102]);
    const read = readCachedEpisodeTitles([101, 102, 103]);
    assert.equal(read.byId[101], 'O Fim da Jornada');
    assert.equal(read.byId[102], undefined);
    assert.deepEqual(read.settledIds, [101, 102]);
    assert.deepEqual(read.missingIds, [103]);

    setCachedAnimeSynopsis('https://topanimes.net/animes/frieren', {
      synopsis: 'Sinopse em PT-BR',
      language: 'pt-BR',
      source: 'thetvdb-pt-br',
    });
    const animeHit = getCachedAnimeSynopsis('https://topanimes.net/animes/frieren/');
    assert.equal(animeHit.hit, true);
    assert.equal(animeHit.value?.synopsis, 'Sinopse em PT-BR');

    setCachedEpisodeSynopsis('https://topanimes.net/episodio/frieren-episodio-1', {
      synopsis: 'Resumo do ep 1',
      language: 'pt-BR',
      source: 'thetvdb-pt-br',
    });
    const epHit = getCachedEpisodeSynopsis('https://topanimes.net/episodio/frieren-episodio-1/');
    assert.equal(epHit.hit, true);
    assert.equal(epHit.value?.synopsis, 'Resumo do ep 1');

    clearPrefetchCaches('all');
    assert.equal(getCachedAnimeSynopsis('https://topanimes.net/animes/frieren/').hit, false);
  });

  it('keeps EpisodeWorkspace decoupled from cheerio/topanimesParser for small web bundles', () => {
    const workspaceTsx = readFileSync(resolve(ROOT, 'src/components/EpisodeWorkspace.tsx'), 'utf8');
    assert.match(workspaceTsx, /from '\.\.\/lib\/serverLabel'/);
    assert.doesNotMatch(
      workspaceTsx,
      /from '\.\.\/lib\/topanimesParser'/,
      'EpisodeWorkspace must import formatServerLabel from serverLabel.ts so web episode opens never load cheerio'
    );
  });
});
