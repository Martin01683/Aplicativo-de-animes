import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLocalizedEpisodeTitles,
  collectUnlocalizedEpisodeIds,
  extractExplicitSeasonNumber,
  formatEpisodeCardBadge,
  formatEpisodeCardTitle,
  formatEpisodeCountdown,
  formatEpisodePlayCtaLabel,
  formatEpisodeReleaseDate,
  formatUpcomingEpisodeNotice,
  isEpisodeAvailableOnServer,
  isEpisodeUncensored,
  isUncensoredEpisodeTitle,
  mergeServerAndCatalogEpisodes,
  parseEpisodeDateToTimestampSec,
  pickImageWithFallback,
  resolveLocalizedEpisodeDisplayTitle,
  stripUncensoredTag,
} from './episodeAvailability';
import { pickLatestAnimeEpisode } from './favoriteAlerts';
import type { AnimeEpisodeLink } from './types';

test('parseEpisodeDateToTimestampSec parses ISO, TheTVDB English, and PT-BR dates reliably', () => {
  const iso = parseEpisodeDateToTimestampSec('2026-11-29');
  const en = parseEpisodeDateToTimestampSec('November 29, 2026');
  const br = parseEpisodeDateToTimestampSec('29/11/2026');
  const ptNamed = parseEpisodeDateToTimestampSec('29 de novembro de 2026');

  assert.ok(iso && iso > 0);
  assert.equal(en, iso);
  assert.equal(br, iso);
  assert.equal(ptNamed, iso);
  assert.equal(parseEpisodeDateToTimestampSec(''), undefined);
  assert.equal(parseEpisodeDateToTimestampSec('TBA'), undefined);
});

test('formatEpisodeReleaseDate formats date-only and exact-time timestamps cleanly', () => {
  const dateOnly = formatEpisodeReleaseDate('2026-11-29', undefined, false);
  assert.equal(dateOnly, '29/11/2026');

  const exactTs = Math.floor(Date.UTC(2026, 10, 29, 17, 30, 0) / 1000);
  const withTime = formatEpisodeReleaseDate('2026-11-29', exactTs, true);
  assert.ok(withTime && /^\d{2}\/\d{2}\/2026 · \d{2}:\d{2}$/.test(withTime));

  assert.equal(formatEpisodeReleaseDate(undefined, undefined, false), null);
  assert.equal(formatEpisodeReleaseDate('Nippon TV', undefined, false), null);
  assert.equal(formatEpisodeReleaseDate('TBA', undefined, false), null);
});

test('formatEpisodeCountdown matches Calendar countdown semantics across future, now, pending, and TBA', () => {
  const nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);
  const nowSec = Math.floor(nowMs / 1000);

  assert.deepEqual(formatEpisodeCountdown(nowSec + 2 * 86400 + 5 * 3600 + 60, nowMs), {
    label: 'Em 2d 5h',
    state: 'future',
  });
  assert.deepEqual(formatEpisodeCountdown(nowSec + 3 * 3600 + 8 * 60, nowMs), {
    label: 'Em 3h 08m',
    state: 'future',
  });
  assert.deepEqual(formatEpisodeCountdown(nowSec + 25 * 60, nowMs), {
    label: 'Em 25m',
    state: 'future',
  });
  assert.deepEqual(formatEpisodeCountdown(nowSec - 15 * 60, nowMs), {
    label: 'Saiu agora',
    state: 'now',
  });
  assert.deepEqual(formatEpisodeCountdown(nowSec - 3 * 3600, nowMs), {
    label: 'Indisponível',
    state: 'pending',
  });
  assert.deepEqual(formatEpisodeCountdown(undefined, nowMs), {
    label: 'A ser anunciada',
    state: 'tba',
  });
  assert.deepEqual(formatEpisodeCountdown(undefined, nowMs, 'Nippon TV'), {
    label: 'A ser anunciada',
    state: 'tba',
  });
});

test('mergeServerAndCatalogEpisodes shows all episodes, enriches playable ones, and upgrades upcoming dates with LiveChart exact timestamps', () => {
  const serverEpisodes: AnimeEpisodeLink[] = [
    {
      numberLabel: '1 - 1',
      episodeNumber: 1,
      seasonNumber: 1,
      title: 'Episódio 1',
      url: 'https://topanimes.net/episodio/goblin-ep-1/',
    },
    {
      numberLabel: '1 - 2',
      episodeNumber: 2,
      seasonNumber: 1,
      title: 'Episódio 2',
      url: 'https://topanimes.net/episodio/goblin-ep-2/',
    },
  ];

  const catalogEpisodes: AnimeEpisodeLink[] = [
    {
      numberLabel: 'EP 1',
      episodeNumber: 1,
      seasonNumber: 1,
      seasonLabel: 'Temporada 1',
      title: 'Episódio 1 — O Início',
      url: 'anisync://episode/anime/thetvdb/999/s1/e1',
      date: 'November 9, 2026',
      thumb: 'https://artworks.thetvdb.com/ep1.jpg',
    },
    {
      numberLabel: 'EP 2',
      episodeNumber: 2,
      seasonNumber: 1,
      seasonLabel: 'Temporada 1',
      title: 'Episódio 2 — A Caverna',
      url: 'anisync://episode/anime/thetvdb/999/s1/e2',
      date: 'November 16, 2026',
    },
    {
      numberLabel: 'EP 3',
      episodeNumber: 3,
      seasonNumber: 1,
      seasonLabel: 'Temporada 1',
      title: 'Episódio 3 — O Desafio',
      url: 'anisync://episode/anime/thetvdb/999/s1/e3',
      date: 'November 23, 2026',
    },
    {
      numberLabel: 'EP 4',
      episodeNumber: 4,
      seasonNumber: 1,
      seasonLabel: 'Temporada 1',
      title: 'Episódio 4 — Novo Caminho',
      url: 'anisync://episode/anime/thetvdb/999/s1/e4',
      date: 'November 30, 2026',
    },
  ];

  const ep3Exact = Math.floor(Date.UTC(2026, 10, 23, 16, 0, 0) / 1000);

  const merged = mergeServerAndCatalogEpisodes({
    serverTitle: 'Tensei Goblin',
    serverUrl: 'https://topanimes.net/animes/tensei-goblin/',
    serverEpisodes,
    catalogEpisodes,
    liveChartHint: {
      livechartId: 12345,
      episodeNumber: 3,
      airingAt: ep3Exact,
      totalEpisodes: 5,
    },
    serverMatched: true,
    tvdbId: 999,
  });

  assert.equal(merged.length, 5);
  // EP 1 and EP 2 are available on server and enriched with TheTVDB title/thumb
  assert.equal(isEpisodeAvailableOnServer(merged[0]), true);
  assert.equal(merged[0].url, 'https://topanimes.net/episodio/goblin-ep-1/');
  assert.equal(merged[0].title, 'Episódio 1 — O Início');
  assert.equal(merged[0].thumb, 'https://artworks.thetvdb.com/ep1.jpg');

  assert.equal(isEpisodeAvailableOnServer(merged[1]), true);

  // EP 3, 4, 5 are unavailable on server with exact & projected weekly timestamps
  assert.equal(isEpisodeAvailableOnServer(merged[2]), false);
  assert.equal(merged[2].airingAt, ep3Exact);
  assert.equal(merged[2].hasExactAiringTime, true);

  assert.equal(isEpisodeAvailableOnServer(merged[3]), false);
  assert.equal(merged[3].airingAt, ep3Exact + 7 * 86400);
  assert.equal(merged[3].hasExactAiringTime, true);

  assert.equal(isEpisodeAvailableOnServer(merged[4]), false);
  assert.equal(merged[4].episodeNumber, 5);
  assert.equal(merged[4].airingAt, ep3Exact + 14 * 86400);

  // pickLatestAnimeEpisode only picks playable server episodes (EP 2, NOT unreleased EP 5!)
  const latest = pickLatestAnimeEpisode(merged, 'Tensei Goblin', 'https://example.com/p.jpg');
  assert.ok(latest);
  assert.equal(latest.episodeNumber, 2);
  assert.equal(latest.episodeUrl, 'https://topanimes.net/episodio/goblin-ep-2/');
});

test('mergeServerAndCatalogEpisodes scopes single-season server pages cleanly', () => {
  assert.equal(extractExplicitSeasonNumber('Black Clover 2nd Season'), 2);
  assert.equal(extractExplicitSeasonNumber('Frieren 2ª Temporada'), 2);
  assert.equal(extractExplicitSeasonNumber('Frieren'), null);

  const merged = mergeServerAndCatalogEpisodes({
    serverTitle: 'Black Clover 2nd Season',
    serverUrl: 'https://topanimes.net/animes/black-clover-2/',
    serverEpisodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/black-clover-2-ep-1/',
      },
    ],
    catalogEpisodes: [
      {
        numberLabel: 'EP 1',
        episodeNumber: 1,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'S1 EP 1',
        url: 'anisync://episode/anime/thetvdb/100/s1/e1',
      },
      {
        numberLabel: 'T2 · EP 1',
        episodeNumber: 1,
        seasonNumber: 2,
        seasonLabel: 'Temporada 2',
        title: 'Episódio 1 — Retorno',
        url: 'anisync://episode/anime/thetvdb/100/s2/e1',
      },
      {
        numberLabel: 'T2 · EP 2',
        episodeNumber: 2,
        seasonNumber: 2,
        seasonLabel: 'Temporada 2',
        title: 'Episódio 2 — Próximo',
        url: 'anisync://episode/anime/thetvdb/100/s2/e2',
        date: '2026-12-01',
      },
    ],
    serverMatched: true,
    tvdbId: 100,
  });

  assert.equal(merged.length, 2);
  assert.equal(merged[0].seasonNumber, 2);
  assert.equal(merged[0].availableOnServer, true);
  assert.equal(merged[0].url, 'https://topanimes.net/episodio/black-clover-2-ep-1/');
  assert.equal(merged[1].seasonNumber, 2);
  assert.equal(merged[1].availableOnServer, false);
});

test('mergeServerAndCatalogEpisodes synthesizes prior & upcoming episodes with dates when only LiveChart hint exists', () => {
  const nowMs = Date.parse('2026-11-23T12:00:00Z');
  const ep4AiringAt = Math.floor(Date.parse('2026-11-25T16:00:00Z') / 1000);

  const merged = mergeServerAndCatalogEpisodes({
    serverTitle: 'Hotaru no Yomeiri Choitashi',
    serverUrl: 'anisync://anime/livechart/999~Hotaru',
    serverEpisodes: [],
    catalogEpisodes: [],
    liveChartHint: {
      livechartId: 999,
      episodeNumber: 4,
      airingAt: ep4AiringAt,
      totalEpisodes: 6,
    },
    serverMatched: false,
  });

  assert.equal(merged.length, 6);
  // Prior episodes (1..3) get projected past weekly dates and "Aguardando servidor"
  assert.equal(merged[0].availableOnServer, false);
  assert.equal(merged[0].hasExactAiringTime, false);
  assert.equal(merged[0].airingAt, ep4AiringAt - 3 * 7 * 86400);
  assert.equal(formatEpisodeCountdown(merged[0].airingAt, nowMs).state, 'pending');

  // Current upcoming episode (4) and subsequent (5..6) get exact time and future countdown
  assert.equal(merged[3].airingAt, ep4AiringAt);
  assert.equal(merged[3].hasExactAiringTime, true);
  assert.equal(formatEpisodeCountdown(merged[3].airingAt, nowMs).label, 'Em 2d 4h');
  assert.equal(merged[5].airingAt, ep4AiringAt + 2 * 7 * 86400);
  assert.equal(merged[5].hasExactAiringTime, true);
});

test('mergeServerAndCatalogEpisodes does not dump mismatched historical seasons when zero server episodes align', () => {
  const merged = mergeServerAndCatalogEpisodes({
    serverTitle: 'Owari no Seraph: Nagoya Kessen-hen',
    serverUrl: 'https://topanimes.net/animes/owari-no-seraph-nagoya-kessen-hen/',
    serverEpisodes: [
      {
        numberLabel: '2 - 1',
        episodeNumber: 1,
        seasonNumber: 2,
        seasonLabel: 'Temporada 2',
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/owari-2-ep-1/',
      },
      {
        numberLabel: '2 - 2',
        episodeNumber: 2,
        seasonNumber: 2,
        seasonLabel: 'Temporada 2',
        title: 'Episódio 2',
        url: 'https://topanimes.net/episodio/owari-2-ep-2/',
      },
    ],
    catalogEpisodes: [
      {
        numberLabel: 'EP 1',
        episodeNumber: 1,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'S1 EP 1',
        url: 'anisync://episode/anime/thetvdb/291/s1/e1',
        date: 'April 4, 2015',
      },
      {
        numberLabel: 'EP 2',
        episodeNumber: 2,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'S1 EP 2',
        url: 'anisync://episode/anime/thetvdb/291/s1/e2',
        date: 'April 11, 2015',
      },
    ],
    serverMatched: true,
    tvdbId: 291,
  });

  assert.equal(merged.length, 2);
  assert.ok(merged.every((ep) => ep.availableOnServer === true));
  assert.equal(merged[0].seasonNumber, 2);
  assert.equal(merged[0].url, 'https://topanimes.net/episodio/owari-2-ep-1/');
});

test('formatUpcomingEpisodeNotice builds clear official forecast messages for player controls', () => {
  const nowMs = Date.parse('2026-11-23T12:00:00Z');
  const nowSec = Math.floor(nowMs / 1000);

  const futureMsg = formatUpcomingEpisodeNotice(
    {
      numberLabel: 'EP 8',
      episodeNumber: 8,
      airingAt: nowSec + 3 * 86400 + 4 * 3600,
      hasExactAiringTime: true,
    },
    nowMs
  );
  assert.match(futureMsg, /^EP 8 ainda não disponível · Previsão oficial:/);
  assert.match(futureMsg, /\(Em 3d 4h\)$/);

  const nowMsg = formatUpcomingEpisodeNotice(
    { numberLabel: 'EP 8', episodeNumber: 8, airingAt: nowSec - 600, hasExactAiringTime: true },
    nowMs
  );
  assert.match(nowMsg, /acabou de estrear/);

  const pendingMsg = formatUpcomingEpisodeNotice(
    { numberLabel: 'EP 3', episodeNumber: 3, date: '2026-10-25', airingAt: nowSec - 86400 * 10 },
    nowMs
  );
  assert.match(pendingMsg, /ainda não está disponível nos servidores/);

  const bareNumMsg = formatUpcomingEpisodeNotice(
    {
      numberLabel: '3',
      episodeNumber: 3,
      airingAt: nowSec + 2 * 86400 + 5 * 3600,
      hasExactAiringTime: true,
    },
    nowMs
  );
  assert.match(bareNumMsg, /^EP 3 ainda não disponível · Previsão oficial:/);
  assert.match(bareNumMsg, /\(Em 2d 5h\)$/);

  const tbaMsg = formatUpcomingEpisodeNotice({ numberLabel: 'EP 9', episodeNumber: 9 }, nowMs);
  assert.match(tbaMsg, /data oficial não confirmada/);
});

test('mergeServerAndCatalogEpisodes prefers TheTVDB episode thumbnails over server thumbnails and falls back cleanly', () => {
  const merged = mergeServerAndCatalogEpisodes({
    serverTitle: 'Frieren',
    serverUrl: 'https://topanimes.net/animes/frieren/',
    serverEpisodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/frieren-ep-1/',
        thumb: 'https://topanimes.net/wp-content/uploads/server-ep1.jpg',
      },
      {
        numberLabel: '1 - 2',
        episodeNumber: 2,
        seasonNumber: 1,
        title: 'Episódio 2',
        url: 'https://topanimes.net/episodio/frieren-ep-2/',
        thumb: 'https://topanimes.net/wp-content/uploads/server-ep2.jpg',
      },
    ],
    catalogEpisodes: [
      {
        numberLabel: 'EP 1',
        episodeNumber: 1,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'Episódio 1 — O Fim da Jornada',
        url: 'anisync://episode/anime/thetvdb/424536/s1/e1',
        thumb: 'https://artworks.thetvdb.com/banners/v4/episode/1/screencap/tvdb-ep1.jpg',
      },
      {
        numberLabel: 'EP 2',
        episodeNumber: 2,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'Episódio 2 — Não Precisava Ser Magia',
        url: 'anisync://episode/anime/thetvdb/424536/s1/e2',
      },
    ],
    serverMatched: true,
    tvdbId: 424536,
  });

  assert.equal(merged.length, 2);
  assert.equal(
    merged[0].thumb,
    'https://artworks.thetvdb.com/banners/v4/episode/1/screencap/tvdb-ep1.jpg'
  );
  assert.equal(merged[1].thumb, 'https://topanimes.net/wp-content/uploads/server-ep2.jpg');
});

test('mergeServerAndCatalogEpisodes keeps all seasons when unifyAllSeasons is true and pickLatestAnimeEpisode prioritizes the latest season', () => {
  const merged = mergeServerAndCatalogEpisodes({
    serverTitle: 'Frieren 2ª Temporada',
    serverUrl: 'https://topanimes.net/animes/frieren-2/',
    serverEpisodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/frieren-ep-1/',
      },
      {
        numberLabel: '1 - 28',
        episodeNumber: 28,
        seasonNumber: 1,
        title: 'Episódio 28',
        url: 'https://topanimes.net/episodio/frieren-ep-28/',
      },
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 2,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/frieren-2-ep-1/',
      },
      {
        numberLabel: '1 - 3',
        episodeNumber: 3,
        seasonNumber: 2,
        title: 'Episódio 3',
        url: 'https://topanimes.net/episodio/frieren-2-ep-3/',
      },
    ],
    catalogEpisodes: [
      {
        numberLabel: 'EP 1',
        episodeNumber: 1,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'Episódio 1 — O Fim da Jornada',
        url: 'anisync://episode/anime/thetvdb/424536/s1/e1',
      },
      {
        numberLabel: 'EP 28',
        episodeNumber: 28,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'Episódio 28 — Seria Constrangedor',
        url: 'anisync://episode/anime/thetvdb/424536/s1/e28',
      },
      {
        numberLabel: 'T2 · EP 1',
        episodeNumber: 1,
        seasonNumber: 2,
        seasonLabel: 'Temporada 2',
        title: 'Episódio 1 — Novo Rumo',
        url: 'anisync://episode/anime/thetvdb/424536/s2/e1',
      },
      {
        numberLabel: 'T2 · EP 3',
        episodeNumber: 3,
        seasonNumber: 2,
        seasonLabel: 'Temporada 2',
        title: 'Episódio 3 — Fronteira Norte',
        url: 'anisync://episode/anime/thetvdb/424536/s2/e3',
      },
    ],
    serverMatched: true,
    tvdbId: 424536,
    unifyAllSeasons: true,
  });

  assert.equal(merged.length, 4);
  assert.equal(merged[2].seasonNumber, 2);
  assert.equal(merged[2].numberLabel, 'T2 · EP 1');

  const latest = pickLatestAnimeEpisode(merged, 'Frieren', 'https://example.com/poster.jpg');
  assert.ok(latest);
  assert.equal(latest.episodeUrl, 'https://topanimes.net/episodio/frieren-2-ep-3/');
  assert.equal(latest.episodeLabel, 'T2 · EP 3');
});

test('uncensored detection, tag stripping, and Option 2 episode card formatters handle Sem Censura and long titles cleanly', () => {
  assert.equal(isUncensoredEpisodeTitle('Episódio 3 (Sem Censura)'), true);
  assert.equal(isUncensoredEpisodeTitle('Episódio 5 - Uncensored'), true);
  assert.equal(isUncensoredEpisodeTitle('Episódio 1'), false);

  assert.equal(stripUncensoredTag('Episódio 3 (Sem Censura)'), 'Episódio 3');
  assert.equal(stripUncensoredTag('Episódio 5 [Uncensored]'), 'Episódio 5');
  assert.equal(stripUncensoredTag('Episódio 6 — Sem Censura'), 'Episódio 6');

  assert.equal(
    formatEpisodeCardBadge({ numberLabel: '1 - 3', episodeNumber: 3, seasonNumber: 1 }),
    'EP 3'
  );
  assert.equal(
    formatEpisodeCardBadge({ numberLabel: '2 - 4', episodeNumber: 4, seasonNumber: 2 }),
    'T2 · EP 4'
  );
  assert.equal(
    formatEpisodeCardBadge({ numberLabel: '1 - 1', episodeNumber: 1, seasonNumber: 1 }, true),
    'Filme'
  );

  assert.equal(
    formatEpisodeCardTitle({
      title: 'Episódio 3 — Dia de piscina no Conselho Estudantil',
      episodeNumber: 3,
    }),
    'Dia de piscina no Conselho Estudantil'
  );
  assert.equal(
    formatEpisodeCardTitle({
      title: 'Episódio 3 (Sem Censura)',
      episodeNumber: 3,
    }),
    'Episódio 3'
  );

  assert.equal(
    formatEpisodePlayCtaLabel({
      title: 'Episódio 1 — Até o pirralho tem seus furos / A presidente foi levada pelo Ume-kun',
      episodeNumber: 1,
      seasonNumber: 1,
    }),
    'Assistir Episódio 1'
  );
  assert.equal(
    formatEpisodePlayCtaLabel(
      { title: 'Filme Completo', episodeNumber: 1, seasonNumber: 1 },
      true
    ),
    'Assistir Filme'
  );
});

test('mergeServerAndCatalogEpisodes preserves uncensored flag while replacing generic Sem Censura server titles with TheTVDB episode titles', () => {
  const merged = mergeServerAndCatalogEpisodes({
    serverTitle: 'Seitokai ni mo Ana wa Aru!',
    serverUrl: 'https://topanimes.net/animes/seitokai/',
    serverEpisodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/seitokai-ep-1/',
      },
      {
        numberLabel: '1 - 3',
        episodeNumber: 3,
        seasonNumber: 1,
        title: 'Episódio 3 (Sem Censura)',
        url: 'https://topanimes.net/episodio/seitokai-ep-3/',
      },
    ],
    catalogEpisodes: [
      {
        numberLabel: 'EP 1',
        episodeNumber: 1,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'Episódio 1 — Até o pirralho tem seus furos',
        url: 'anisync://episode/anime/thetvdb/463051/s1/e1',
      },
      {
        numberLabel: 'EP 3',
        episodeNumber: 3,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'Episódio 3 — Dia de piscina no Conselho Estudantil',
        url: 'anisync://episode/anime/thetvdb/463051/s1/e3',
      },
    ],
    serverMatched: true,
    tvdbId: 463051,
  });

  assert.equal(merged.length, 2);
  assert.equal(merged[0].title, 'Episódio 1 — Até o pirralho tem seus furos');
  assert.equal(isEpisodeUncensored(merged[0]), false);

  assert.equal(merged[1].title, 'Episódio 3 — Dia de piscina no Conselho Estudantil');
  assert.equal(merged[1].uncensored, true);
  assert.equal(isEpisodeUncensored(merged[1]), true);
  assert.equal(formatEpisodeCardTitle(merged[1]), 'Dia de piscina no Conselho Estudantil');
});

test('collectUnlocalizedEpisodeIds and applyLocalizedEpisodeTitles localize player drawer episodes without mutating input', () => {
  const rawEpisodes: AnimeEpisodeLink[] = [
    {
      numberLabel: '1 - 1',
      episodeNumber: 1,
      seasonNumber: 1,
      title: 'Episódio 1 — O Despertar',
      url: 'https://topanimes.net/ep/1/',
      tvdbEpisodeId: 1001,
      titleLocalized: true,
    },
    {
      numberLabel: '1 - 7',
      episodeNumber: 7,
      seasonNumber: 1,
      title: 'Episódio 7 — Let\'s See How Far I Can Go',
      url: 'https://topanimes.net/ep/7/',
      tvdbEpisodeId: 1007,
      titleLocalized: false,
    },
    {
      numberLabel: '1 - 8',
      episodeNumber: 8,
      seasonNumber: 1,
      title: 'Episódio 8 — This Is Frustrating',
      url: 'https://topanimes.net/ep/8/',
      tvdbEpisodeId: 1008,
    },
  ];

  assert.deepEqual(collectUnlocalizedEpisodeIds(rawEpisodes), [1007, 1008]);
  assert.deepEqual(collectUnlocalizedEpisodeIds(rawEpisodes, true), []);

  const unchanged = applyLocalizedEpisodeTitles(rawEpisodes, {});
  assert.equal(unchanged, rawEpisodes);

  const localized = applyLocalizedEpisodeTitles(rawEpisodes, {
    1007: 'Vamos Ver Até Onde Eu Consigo Ir',
    1008: 'Isso É Frustrante',
  });
  assert.notEqual(localized, rawEpisodes);
  assert.equal(localized[0].title, 'Episódio 1 — O Despertar');
  assert.equal(localized[1].title, 'Vamos Ver Até Onde Eu Consigo Ir');
  assert.equal(localized[1].titleLocalized, true);
  assert.equal(localized[2].title, 'Isso É Frustrante');
  assert.equal(localized[2].titleLocalized, true);
  assert.equal(formatEpisodeCardTitle(localized[1]), 'Vamos Ver Até Onde Eu Consigo Ir');
  // Original array remains unmutated
  assert.equal(rawEpisodes[1].title, 'Episódio 7 — Let\'s See How Far I Can Go');
});

test('mergeServerAndCatalogEpisodes builds matched episodes authoritatively from TheTVDB metadata while attaching provider playback links', () => {
  const merged = mergeServerAndCatalogEpisodes({
    serverTitle: 'Sousou no Frieren',
    serverUrl: 'https://topanimes.net/animes/sousou-no-frieren/',
    serverEpisodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Sousou no Frieren Episódio 1 Dublado HD',
        url: 'https://topanimes.net/episodio/frieren-ep-1/',
        date: '15/01/2025',
        thumb: 'https://topanimes.net/uploads/provider-thumb-1.jpg',
        overview: 'Sinopse genérica do provedor',
        durationMinutes: 20,
        audioType: 'DUB',
      },
    ],
    catalogEpisodes: [
      {
        numberLabel: 'EP 1',
        episodeNumber: 1,
        seasonNumber: 1,
        seasonLabel: 'Temporada 1',
        title: 'Episódio 1 — O Fim da Jornada',
        titleLocalized: true,
        url: 'anisync://episode/anime/thetvdb/424536/s1/e1',
        date: '2023-09-29',
        thumb: 'https://artworks.thetvdb.com/banners/v4/episode/9901/screencap/ep1.jpg',
        overview: 'Sinopse oficial do TheTVDB em PT-BR.',
        durationMinutes: 28,
        tvdbEpisodeId: 9901,
      },
    ],
    serverMatched: true,
    tvdbId: 424536,
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'Episódio 1 — O Fim da Jornada');
  assert.equal(merged[0].titleLocalized, true);
  assert.equal(merged[0].numberLabel, 'EP 1');
  assert.equal(merged[0].date, '2023-09-29');
  assert.equal(
    merged[0].thumb,
    'https://artworks.thetvdb.com/banners/v4/episode/9901/screencap/ep1.jpg'
  );
  assert.equal(
    merged[0].fallbackThumb,
    'https://topanimes.net/uploads/provider-thumb-1.jpg'
  );
  assert.equal(merged[0].overview, 'Sinopse oficial do TheTVDB em PT-BR.');
  assert.equal(merged[0].durationMinutes, 28);
  assert.equal(merged[0].tvdbEpisodeId, 9901);
  // Playback fields come strictly from the matched provider
  assert.equal(merged[0].url, 'https://topanimes.net/episodio/frieren-ep-1/');
  assert.equal(merged[0].audioType, 'DUB');
  assert.equal(merged[0].availableOnServer, true);
});

test('pickImageWithFallback prioritizes TheTVDB artwork and falls back cleanly to provider images on failure', () => {
  const tvdbPoster = 'https://artworks.thetvdb.com/frieren-poster.jpg';
  const providerPoster = 'https://topanimes.net/frieren-provider.jpg';
  const tvdbBackdrop = 'https://artworks.thetvdb.com/frieren-backdrop.jpg';

  assert.equal(
    pickImageWithFallback([tvdbPoster, providerPoster, tvdbBackdrop], []),
    tvdbPoster
  );
  assert.equal(
    pickImageWithFallback([tvdbPoster, providerPoster, tvdbBackdrop], [tvdbPoster]),
    providerPoster
  );
  assert.equal(
    pickImageWithFallback([tvdbPoster, providerPoster, tvdbBackdrop], [tvdbPoster, providerPoster]),
    tvdbBackdrop
  );
  assert.equal(
    pickImageWithFallback(
      [tvdbPoster, providerPoster, tvdbBackdrop],
      [tvdbPoster, providerPoster, tvdbBackdrop]
    ),
    ''
  );
});

test('mergeServerAndCatalogEpisodes ignores mismatched future LiveChart hints on ended seasons and never synthesizes episodes past a finale', () => {
  const serverEpisodes: AnimeEpisodeLink[] = [
    {
      numberLabel: '3 - 8',
      episodeNumber: 8,
      seasonNumber: 3,
      title: 'Episódio 8',
      url: 'https://topanimes.net/episodio/konosuba-3-ep-8/',
    },
    {
      numberLabel: '3 - 9',
      episodeNumber: 9,
      seasonNumber: 3,
      title: 'Episódio 9',
      url: 'https://topanimes.net/episodio/konosuba-3-ep-9/',
    },
    {
      numberLabel: '3 - 10',
      episodeNumber: 10,
      seasonNumber: 3,
      title: 'Episódio 10',
      url: 'https://topanimes.net/episodio/konosuba-3-ep-10/',
    },
    {
      numberLabel: '3 - 11',
      episodeNumber: 11,
      seasonNumber: 3,
      title: 'Episódio 11',
      url: 'https://topanimes.net/episodio/konosuba-3-ep-11/',
    },
  ];

  const catalogEpisodes: AnimeEpisodeLink[] = [
    {
      numberLabel: 'T3 · EP 8',
      episodeNumber: 8,
      seasonNumber: 3,
      seasonLabel: 'Temporada 3',
      title: 'Um descanso eterno para o mestre deste lago!',
      titleLocalized: true,
      url: 'anisync://episode/anime/thetvdb/303867/s3/e8',
      date: '2024-05-29',
    },
    {
      numberLabel: 'T3 · EP 9',
      episodeNumber: 9,
      seasonNumber: 3,
      seasonLabel: 'Temporada 3',
      title: 'Uma conversa para este fugitivo!',
      titleLocalized: true,
      url: 'anisync://episode/anime/thetvdb/303867/s3/e9',
      date: '2024-06-05',
    },
    {
      numberLabel: 'T3 · EP 10',
      episodeNumber: 10,
      seasonNumber: 3,
      seasonLabel: 'Temporada 3',
      title: 'Bênçãos para esta noiva egoísta!',
      titleLocalized: true,
      url: 'anisync://episode/anime/thetvdb/303867/s3/e10',
      date: '2024-06-12',
    },
    {
      numberLabel: 'T3 · EP 11',
      episodeNumber: 11,
      seasonNumber: 3,
      seasonLabel: 'Temporada 3',
      title: 'Bênçãos Divinas Para Esses Dias Sem Mudanças!',
      titleLocalized: true,
      finaleType: 'series',
      url: 'anisync://episode/anime/thetvdb/303867/s3/e11',
      date: '2024-06-19',
    },
  ];

  // Mismatched 2026 LiveChart schedule hint (e.g. another show / spin-off / different season)
  const mismatchedMerged = mergeServerAndCatalogEpisodes({
    serverTitle: 'KonoSuba',
    serverUrl: 'https://topanimes.net/animes/konosuba/',
    serverEpisodes,
    catalogEpisodes,
    liveChartHint: {
      livechartId: 77777,
      episodeNumber: 9,
      airingAt: Math.floor(Date.UTC(2026, 10, 26, 15, 30, 0) / 1000),
      totalEpisodes: 13,
    },
    serverMatched: true,
    tvdbId: 303867,
    unifyAllSeasons: true,
  });

  // Must NOT overwrite EP 9's 2024 date with 2026 and must NOT synthesize phantom EP 12 / EP 13 after Final da série!
  assert.equal(mismatchedMerged.length, 4);
  const ep9 = mismatchedMerged.find((e) => e.episodeNumber === 9);
  assert.ok(ep9);
  assert.equal(ep9.date, '2024-06-05');
  assert.equal(ep9.hasExactAiringTime, false);
  const ep11 = mismatchedMerged.find((e) => e.episodeNumber === 11);
  assert.equal(ep11?.finaleType, 'series');
  assert.equal(mismatchedMerged.some((e) => (e.episodeNumber || 0) > 11), false);

  // Even for a genuinely currently-airing season whose finale is marked at EP 11,
  // LiveChart may upgrade EP 9..11 timestamps, but must STILL cap at EP 11 (never synthesize EP 12/13).
  const activeSeasonCatalog: AnimeEpisodeLink[] = [
    {
      numberLabel: 'EP 9',
      episodeNumber: 9,
      seasonNumber: 1,
      seasonLabel: 'Temporada 1',
      title: 'Episódio 9 — Clímax',
      url: 'anisync://episode/anime/thetvdb/500/s1/e9',
      date: '2026-11-26',
    },
    {
      numberLabel: 'EP 10',
      episodeNumber: 10,
      seasonNumber: 1,
      seasonLabel: 'Temporada 1',
      title: 'Episódio 10 — Quase lá',
      url: 'anisync://episode/anime/thetvdb/500/s1/e10',
      date: '2026-12-03',
    },
    {
      numberLabel: 'EP 11',
      episodeNumber: 11,
      seasonNumber: 1,
      seasonLabel: 'Temporada 1',
      title: 'Episódio 11 — Epílogo',
      finaleType: 'season',
      url: 'anisync://episode/anime/thetvdb/500/s1/e11',
      date: '2026-12-10',
    },
  ];
  const ep9Live = Math.floor(Date.UTC(2026, 10, 26, 15, 30, 0) / 1000);
  const cappedAiring = mergeServerAndCatalogEpisodes({
    serverTitle: 'Anime Atual',
    serverUrl: 'https://topanimes.net/animes/anime-atual/',
    serverEpisodes: [],
    catalogEpisodes: activeSeasonCatalog,
    liveChartHint: {
      livechartId: 88888,
      episodeNumber: 9,
      airingAt: ep9Live,
      totalEpisodes: 13,
    },
    serverMatched: false,
    tvdbId: 500,
  });
  assert.equal(cappedAiring.length, 11);
  assert.equal(cappedAiring.some((e) => (e.episodeNumber || 0) > 11), false);
  const cappedEp9 = cappedAiring.find((e) => e.episodeNumber === 9);
  const cappedEp11 = cappedAiring.find((e) => e.episodeNumber === 11);
  assert.equal(cappedEp9?.airingAt, ep9Live);
  assert.equal(cappedEp9?.hasExactAiringTime, true);
  assert.equal(cappedEp11?.episodeNumber, 11);
  assert.equal(cappedEp11?.airingAt, ep9Live + 14 * 86400);
});

test('resolveLocalizedEpisodeDisplayTitle aligns EpisodeWorkspace headings & player titles with TheTVDB PT-BR titles', () => {
  const localized = resolveLocalizedEpisodeDisplayTitle({
    episodeTitle: 'KonoSuba 3 Episódio 8',
    episodeLabel: 'Episódio 8',
    episodeNumber: 8,
    seasonNumber: 3,
    matchedSeriesEpisode: {
      numberLabel: 'T3 · EP 8',
      episodeNumber: 8,
      seasonNumber: 3,
      title: 'Episódio 8 — Um descanso eterno para o mestre deste lago!',
      titleLocalized: true,
    },
  });
  assert.equal(localized.usedCatalogTitle, true);
  assert.equal(localized.badge, 'T3 · EP 8');
  assert.equal(localized.headingTitle, 'Um descanso eterno para o mestre deste lago!');
  assert.equal(
    localized.playerTitle,
    'T3 · EP 8 — Um descanso eterno para o mestre deste lago!'
  );

  // Falls back to /api/episode-synopsis localized title before series list finishes hydrating
  const fromSynopsis = resolveLocalizedEpisodeDisplayTitle({
    episodeTitle: 'KonoSuba 3 Episódio 9',
    episodeLabel: '3 - 9',
    episodeNumber: 9,
    seasonNumber: 3,
    matchedSeriesEpisode: {
      numberLabel: 'T3 · EP 9',
      episodeNumber: 9,
      seasonNumber: 3,
      title: 'Episódio 9',
      titleLocalized: false,
    },
    tvdbEpisodeTitle: 'Uma conversa para este fugitivo!',
  });
  assert.equal(fromSynopsis.usedCatalogTitle, true);
  assert.equal(fromSynopsis.headingTitle, 'Uma conversa para este fugitivo!');
  assert.equal(fromSynopsis.playerTitle, 'T3 · EP 9 — Uma conversa para este fugitivo!');

  // Movies preserve their original movie title without injecting an episode prefix
  const movie = resolveLocalizedEpisodeDisplayTitle({
    episodeTitle: 'KonoSuba: Legend of Crimson',
    isMovie: true,
    tvdbEpisodeTitle: 'Ignored',
  });
  assert.equal(movie.usedCatalogTitle, false);
  assert.equal(movie.headingTitle, 'KonoSuba: Legend of Crimson');
  assert.equal(movie.playerTitle, 'KonoSuba: Legend of Crimson');
});





