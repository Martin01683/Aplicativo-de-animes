import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  enrichDetailsWithMyAnimeListRating,
  MAL_PREFIX_SEARCH_URL,
  normalizeMalScore,
  parseMalAnimePageScore,
  parseMalIdFromUrl,
  parseMalPrefixSearchJson,
} from './catalog/providers/malProvider.ts';
import type { HttpFetcher } from './httpTypes.ts';
import type { AnimeDetails } from './types.ts';

function makeAnime(overrides: Partial<AnimeDetails> = {}): AnimeDetails {
  return {
    title: 'Sousou no Frieren',
    originalTitle: '葬送のフリーレン',
    url: 'https://topanimes.net/animes/sousou-no-frieren/',
    kind: 'anime',
    poster: '',
    backdrop: '',
    synopsis: 'Sinopse',
    year: '2023',
    rating: '7.6',
    genres: ['Aventura', 'Fantasia'],
    audioType: 'LEG',
    episodes: [],
    ...overrides,
  };
}

describe('MyAnimeList rating provider with provider fallback', () => {
  it('parses MAL IDs, scores, anime page HTML, and prefix search JSON cleanly', () => {
    assert.equal(parseMalIdFromUrl('https://myanimelist.net/anime/52991/Sousou_no_Frieren'), 52991);
    assert.equal(parseMalIdFromUrl('https://example.com/anime/123'), null);

    assert.equal(normalizeMalScore('9.24'), '9.24');
    assert.equal(normalizeMalScore('8.1'), '8.10');
    assert.equal(normalizeMalScore('N/A'), null);
    assert.equal(normalizeMalScore('0'), null);

    assert.equal(
      parseMalAnimePageScore('<div itemprop="ratingValue" class="score-label score-9">9.24</div>'),
      '9.24'
    );

    const parsed = parseMalPrefixSearchJson(
      JSON.stringify({
        categories: [
          {
            type: 'anime',
            items: [
              {
                id: 52991,
                name: 'Sousou no Frieren',
                url: 'https://myanimelist.net/anime/52991/Sousou_no_Frieren',
                payload: { media_type: 'TV', start_year: 2023, score: '9.24' },
              },
            ],
          },
        ],
      })
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, 52991);
    assert.equal(parsed[0].score, '9.24');
  });

  it('fetches live MAL score directly when malId or myAnimeListUrl is known and caches per fetcher', async () => {
    let calls = 0;
    const fetchHttp: HttpFetcher = async (url) => {
      calls += 1;
      if (url === 'https://myanimelist.net/anime/52991') {
        return {
          status: 200,
          ok: true,
          finalUrl: 'https://myanimelist.net/anime/52991/Sousou_no_Frieren',
          body: '<div itemprop="ratingValue" class="score-label score-9">9.24</div>',
        };
      }
      return { status: 404, ok: false, finalUrl: url, body: '' };
    };

    const anime = makeAnime({
      rating: '7.6',
      myAnimeListUrl: 'https://myanimelist.net/anime/52991/Sousou_no_Frieren',
    });

    const enriched = await enrichDetailsWithMyAnimeListRating(fetchHttp, anime);
    assert.equal(enriched.rating, '9.24');
    assert.equal(enriched.ratingSource, 'myanimelist');
    assert.equal(enriched.externalIds?.malId, 52991);
    assert.equal(
      enriched.externalLinks?.some((l) => l.source === 'myanimelist' && l.url.includes('/52991')),
      true
    );

    // Second call hits per-fetcher cache
    const cached = await enrichDetailsWithMyAnimeListRating(fetchHttp, anime);
    assert.equal(cached.rating, '9.24');
    assert.equal(calls, 1);
  });

  it('resolves MAL score via myanimelist.net prefix JSON search when malId is absent', async () => {
    const fetchHttp: HttpFetcher = async (url) => {
      if (url.startsWith(MAL_PREFIX_SEARCH_URL)) {
        return {
          status: 200,
          ok: true,
          finalUrl: url,
          body: JSON.stringify({
            categories: [
              {
                type: 'anime',
                items: [
                  {
                    id: 59978,
                    name: 'Sousou no Frieren 2nd Season',
                    url: 'https://myanimelist.net/anime/59978/Sousou_no_Frieren_2nd_Season',
                    payload: { media_type: 'TV', start_year: 2026, score: '8.83' },
                  },
                  {
                    id: 52991,
                    name: 'Sousou no Frieren',
                    url: 'https://myanimelist.net/anime/52991/Sousou_no_Frieren',
                    payload: { media_type: 'TV', start_year: 2023, score: '9.24' },
                  },
                ],
              },
            ],
          }),
        };
      }
      return { status: 404, ok: false, finalUrl: url, body: '' };
    };

    const enriched = await enrichDetailsWithMyAnimeListRating(
      fetchHttp,
      makeAnime({ title: 'Sousou no Frieren', originalTitle: 'Sousou no Frieren', year: '2023' })
    );
    assert.equal(enriched.rating, '9.24');
    assert.equal(enriched.ratingSource, 'myanimelist');
    assert.equal(enriched.externalIds?.malId, 52991);
  });

  it('falls back cleanly to provider rating when MyAnimeList is unavailable or returns N/A', async () => {
    const fetchHttp: HttpFetcher = async (url) => ({
      status: 503,
      ok: false,
      finalUrl: url,
      body: 'Service Unavailable',
    });

    const anime = makeAnime({ rating: '7.6' });
    const enriched = await enrichDetailsWithMyAnimeListRating(fetchHttp, anime);
    assert.equal(enriched.rating, '7.6');
    assert.equal(enriched.ratingSource, 'provider');
  });

  it('never truncates Informações cell values in AnimeDetailView and lists MyAnimeList in SettingsModal', () => {
    const view = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/AnimeDetailView.tsx'),
      'utf8'
    );
    const infoStart = view.indexOf('data-anime-info-panel="true"');
    const infoEnd = view.indexOf('data-anime-actions="true"');
    assert.ok(infoStart > 0 && infoEnd > infoStart);
    const infoSection = view.slice(infoStart, infoEnd);
    assert.doesNotMatch(infoSection, /<dd[\s\S]*?\btruncate\b/);
    assert.doesNotMatch(infoSection, /data-rating-source="myanimelist"/);
    assert.match(infoSection, /data-anime-meta-chip=\{meta\.id\}/);

    const settings = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/SettingsModal.tsx'),
      'utf8'
    );
    assert.match(settings, /MyAnimeList/);
  });
});
