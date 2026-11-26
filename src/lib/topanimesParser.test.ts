import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  extractDooPlayAjaxConfig,
  extractDooPlayNonce,
  extractMissingDooPlayerOptions,
  extractStreamsFromEmbed,
  formatServerLabel,
  parseAnimePageHtml,
  parseCalendarPageHtml,
  parseCatalogArchiveHtml,
  parseDooPlayerAjaxResponse,
  parseEpisodePageHtml,
  parseEpisodesArchiveHtml,
  parseHomeHtml,
  parseSearchHtml,
  parseSearchPageHtml,
  parseWpGlossaryJson,
  parseWpSearchJson,
} from './topanimesParser.ts';
import { isSafeExternalHttpUrl, isTopAnimesUrl, unwrapAvisoUrl } from './urlSafety.ts';

const ROOT = process.cwd();
const HOME_CAPTURE = path.join(
  ROOT,
  'tests/fixtures/topanimes/captura-topanimes.net-20261120-185536_c8f54b4e.html'
);
const EPISODE_CAPTURE = path.join(
  ROOT,
  'tests/fixtures/topanimes/captura-topanimes.net-20261120-185622_7446cc49.html'
);
const EPISODES_ARCHIVE_CAPTURE = path.join(
  ROOT,
  'tests/fixtures/topanimes/captura-topanimes.net-20261120-193317_58010c0a.html'
);
const SEARCH_CAPTURE = path.join(
  ROOT,
  'tests/fixtures/topanimes/captura-topanimes.net-20261120-193320_0ff36db0.html'
);
const ANIMES_ARCHIVE_CAPTURE = path.join(
  ROOT,
  'tests/fixtures/topanimes/captura-topanimes.net-20261120-194623_978b4a6c.html'
);
const MOVIES_ARCHIVE_CAPTURE = path.join(
  ROOT,
  'tests/fixtures/topanimes/captura-topanimes.net-20261120-194902_e963a754.html'
);

describe('urlSafety', () => {
  it('unwraps /aviso/?url= wrappers and strips malformed &poster= suffixes', () => {
    const wrapped =
      'https://topanimes.net/aviso/?url=https%3A%2F%2Fcsst.online%2Fembed%2F1095810%26poster%3Dhttps%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fabc.jpg';
    assert.equal(unwrapAvisoUrl(wrapped), 'https://csst.online/embed/1095810');

    const abyssWrapped =
      'https://topanimes.net/aviso/?url=https%3A%2F%2Fabyssplayer.com%2F6Lio1p48-%3Fthumbnail%3Dhttps%3A%2F%2Fimage.tmdb.org%2Ffoo.jpg';
    assert.equal(
      unwrapAvisoUrl(abyssWrapped),
      'https://abyssplayer.com/6Lio1p48-?thumbnail=https://image.tmdb.org/foo.jpg'
    );
  });

  it('blocks private IPs, localhost, non-http schemes, and credentials', () => {
    assert.equal(isSafeExternalHttpUrl('http://127.0.0.1:3000/test'), false);
    assert.equal(isSafeExternalHttpUrl('http://169.254.169.254/latest/meta-data'), false);
    assert.equal(isSafeExternalHttpUrl('http://10.0.0.1/internal'), false);
    assert.equal(isSafeExternalHttpUrl('http://192.168.1.10/admin'), false);
    assert.equal(isSafeExternalHttpUrl('http://localhost:8080/'), false);
    assert.equal(isSafeExternalHttpUrl('http://[::1]/'), false);
    assert.equal(isSafeExternalHttpUrl('file:///etc/passwd'), false);
    assert.equal(isSafeExternalHttpUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalHttpUrl('https://user:pass@topanimes.net/'), false);
    assert.equal(isSafeExternalHttpUrl('https://cdn.example.com/video.m3u8'), true);
    assert.equal(isTopAnimesUrl('https://topanimes.net/animes/test/'), true);
    assert.equal(isTopAnimesUrl('https://evil.com/topanimes.net'), false);
  });
});

describe('topanimesParser', () => {
  it('parses the real homepage HTML capture into calendar, releases, animes, and movies', () => {
    const html = fs.readFileSync(HOME_CAPTURE, 'utf8');
    const catalog = parseHomeHtml(html, 'snapshot');

    assert.equal(catalog.sourceMode, 'snapshot');
    assert.equal(catalog.calendar.length, 14);
    assert.equal(catalog.releases.length, 32);
    assert.equal(catalog.animes.length, 10);
    assert.equal(catalog.movies.length, 10);

    const firstRelease = catalog.releases[0];
    assert.equal(firstRelease.title, 'Hotaru no Yomeiri Dublado');
    assert.equal(firstRelease.episodeLabel, 'Episódio 4');
    assert.equal(firstRelease.audioType, 'DUB');
    assert.equal(firstRelease.quality, 'FHD');

    const hiatusItem = catalog.calendar.find((c) => c.isHiatus);
    assert.ok(hiatusItem, 'Expected at least one HIATO item in calendar');
  });

  it('parses the real episode HTML capture and unwraps all 5 player servers', () => {
    const html = fs.readFileSync(EPISODE_CAPTURE, 'utf8');
    const ep = parseEpisodePageHtml(
      html,
      'https://topanimes.net/episodio/kusuriya-no-hitorigoto-3-episodio-8/'
    );

    assert.equal(ep.seriesTitle, 'Kusuriya no Hitorigoto 3');
    assert.equal(ep.episodeLabel, 'Episódio 8');
    assert.equal(ep.seriesUrl, 'https://topanimes.net/animes/kusuriya-no-hitorigoto-3/');
    assert.equal(ep.prevUrl, 'https://topanimes.net/episodio/kusuriya-no-hitorigoto-3-episodio-7/');
    assert.equal(ep.nextUrl, undefined);
    assert.deepEqual(ep.genres, ['Drama', 'Histórico', 'Medical', 'Mistério']);

    assert.equal(ep.options.length, 4);
    assert.deepEqual(
      ep.options.map((o) => o.label),
      ['KojimaCDN', 'Zuplay', 'Vidstreaming', 'Ruplay']
    );
    assert.equal(formatServerLabel('ruplay'), 'Ruplay');
    assert.equal(formatServerLabel('aniplay'), 'Aniplay');
    assert.equal(formatServerLabel('KojimaCDN'), 'KojimaCDN');
    assert.equal(ep.options[3].embedUrl, 'https://csst.online/embed/1095810');
  });

  it('extracts streams and subtitles across Vidstreaming, JW Player, Playerjs, and Blogger formats', () => {
    const vidstreaming = extractStreamsFromEmbed(
      'https://sk-boyceta.booonceivu.shop/?id=demo',
      JSON.stringify({
        status: 'success',
        capa: 'https://img.example.com/cover.jpg',
        midias: [
          { qualidade: 'SD', url: 'https://cdn.example.com/sd.m3u8' },
          { qualidade: 'FHD', url: 'https://cdn.example.com/fhd.m3u8' },
        ],
        legendas: [{ label: 'Português (BR)', url: 'https://cdn.example.com/pt.vtt' }],
      })
    );
    assert.equal(vidstreaming.streams.length, 2);
    assert.equal(vidstreaming.streams[0].height, 1080);
    assert.equal(vidstreaming.subtitles[0].isDefault, true);

    const playerjs = extractStreamsFromEmbed(
      'https://csst.online/embed/1095810',
      `<script>new Playerjs({id:'v1', subtitle:'[Português]https://cdn.example.com/sub.srt', file:'[360p]https://cdn.example.com/360.mp4/,[1080p]https://cdn.example.com/1080.mp4/'});</script>`
    );
    assert.equal(playerjs.streams[0].height, 1080);
    assert.equal(playerjs.streams[0].format, 'mp4');
    assert.equal(playerjs.streams[1].height, 360);
    assert.equal(playerjs.subtitles[0].url, 'https://cdn.example.com/sub.srt');

    const jw = extractStreamsFromEmbed(
      'https://topanimes.net/antivirus2/yes/?id=demo',
      `<script>jwplayer("player").setup({ sources: [{file: "https://cdn.example.com/cdn_stream.m3u8?token=abc", type: "hls", label: "1080p"}] });</script>`
    );
    assert.equal(jw.streams[0].format, 'hls');
    assert.equal(jw.streams[0].height, 1080);
  });

  it('parses anime page episodes, search HTML, and WP JSON', () => {
    const animeHtml = `
      <div class="sheader"><div class="poster"><img src="https://image.tmdb.org/t/p/w500/p.jpg"/></div>
      <div class="data"><h1>Kusuriya no Hitorigoto 3</h1></div></div>
      <div class="wp-content"><p>Sinopse de teste.</p></div>
      <div class="sgeneros"><a>Drama</a><a>Mistério</a></div>
      <div id="seasons"><ul class="episodios">
        <li><div class="imagen"><img src="https://image.tmdb.org/t/p/w154/e1.jpg"/></div>
        <div class="numerando">3 - 1</div><div class="epnumber">1</div>
        <div class="episodiotitle"><a href="https://topanimes.net/episodio/kusuriya-no-hitorigoto-3-episodio-1/">Episódio 1</a><span class="date">02/10/26</span></div></li>
      </ul></div>`;
    const anime = parseAnimePageHtml(animeHtml, 'https://topanimes.net/animes/kusuriya-no-hitorigoto-3/');
    assert.equal(anime.title, 'Kusuriya no Hitorigoto 3');
    assert.equal(anime.episodes.length, 1);
    assert.equal(anime.episodes[0].episodeNumber, 1);
    assert.equal(anime.episodes[0].seasonNumber, 3);
    assert.equal(anime.episodes[0].seasonLabel, 'Temporada 3');

    const searchHtml = `<div class="search-page"><div class="result-item"><article>
      <div class="thumbnail"><a href="https://topanimes.net/animes/kusuriya-no-hitorigoto-3-dublado/"><img src="https://image.tmdb.org/t/p/w92/s.jpg"/></a></div>
      <div class="details"><div class="title"><a href="https://topanimes.net/animes/kusuriya-no-hitorigoto-3-dublado/">Kusuriya no Hitorigoto 3 Dublado</a></div>
      <div class="meta"><span class="year">2023</span></div><div class="contenido"><p>Dublada</p></div></div>
    </article></div></div>`;
    const sr = parseSearchHtml(searchHtml);
    assert.equal(sr.length, 1);
    assert.equal(sr[0].audioType, 'DUB');
    assert.equal(sr[0].poster, 'https://image.tmdb.org/t/p/w342/s.jpg');

    const wp = parseWpSearchJson({
      '1': { title: 'Frieren', url: 'https://topanimes.net/animes/frieren/', img: 'https://image.tmdb.org/f.jpg' },
    });
    assert.equal(wp.length, 1);
    assert.equal(wp[0].title, 'Frieren');
  });

  it('parses the real /episodio/ archive HTML capture with pagination metadata', () => {
    const html = fs.readFileSync(EPISODES_ARCHIVE_CAPTURE, 'utf8');
    const archive = parseEpisodesArchiveHtml(html);

    assert.equal(archive.items.length, 30);
    assert.equal(archive.currentPage, 1);
    assert.equal(archive.totalPages, 893);
    assert.equal(archive.items[0].kind, 'episode');
    assert.ok(archive.items[0].poster.startsWith('https://'));
  });

  it('parses the real search capture with pagination, HD poster upgrade, and movie badges', () => {
    const html = fs.readFileSync(SEARCH_CAPTURE, 'utf8');
    const parsed = parseSearchPageHtml(html);

    assert.equal(parsed.results.length, 30);
    assert.equal(parsed.currentPage, 1);
    assert.equal(parsed.totalPages, 55);
    assert.ok(parsed.results[0].poster.includes('/t/p/w342/'));
    const movie = parsed.results.find((r) => r.title.includes('Espermagedom'));
    assert.ok(movie);
    assert.equal(movie.kind, 'movie');
  });

  it('parses archive catalog pages for animes and movies', () => {
    const html = `
      <div id="archive-content" class="items">
        <article class="item tvshows">
          <div class="poster"><img src="https://image.tmdb.org/t/p/w185/a.jpg" /></div>
          <div class="rating">8.5</div>
          <div class="data"><h3><a href="https://topanimes.net/animes/demo/">Demo Anime</a></h3><span>2026</span></div>
        </article>
        <article class="item movies">
          <div class="poster"><img src="https://image.tmdb.org/t/p/w185/m.jpg" /></div>
          <div class="quality">FHD</div>
          <div class="data"><h3><a href="https://topanimes.net/filmes/demo-filme/">Demo Filme</a></h3><span>2025</span></div>
        </article>
      </div>
      <div class="pagination"><span>Page 2 of 48</span></div>`;
    const parsed = parseCatalogArchiveHtml(html, 'anime');
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0].kind, 'anime');
    assert.equal(parsed.items[1].kind, 'movie');
    assert.equal(parsed.currentPage, 2);
    assert.equal(parsed.totalPages, 48);
  });

  it('parses the real /animes/ HTML capture with separate featured items, 30 archive items, and genre/year/type filters', () => {
    const html = fs.readFileSync(ANIMES_ARCHIVE_CAPTURE, 'utf8');
    const parsed = parseCatalogArchiveHtml(html, 'anime');

    assert.equal(parsed.featured.length, 8);
    assert.equal(parsed.featured[0].title, 'Kimetsu no Yaiba: Hashira Geiko-hen');
    assert.ok(parsed.featured[0].poster.includes('/t/p/w342/'));

    assert.equal(parsed.items.length, 30);
    assert.equal(parsed.currentPage, 1);
    assert.equal(parsed.totalPages, 48);
    assert.ok(parsed.items[0].poster.includes('/t/p/w342/'));

    assert.ok(parsed.filters.genres.length > 50);
    assert.equal(parsed.filters.genres.some((g) => g.slug === 'acao' && g.label === 'Ação'), true);
    assert.equal(parsed.filters.years[0].slug, '2026');
    assert.ok(parsed.filters.types.some((t) => t.slug === 'donghua'));
    assert.ok(parsed.filters.types.some((t) => t.slug === 'dublado'));
    assert.equal(parsed.featured.find((f) => f.title === 'Solo Leveling')?.rating, undefined);
  });

  it('parses the real /filmes/ HTML capture with hero slider movies and 30 FHD movie items', () => {
    const html = fs.readFileSync(MOVIES_ARCHIVE_CAPTURE, 'utf8');
    const parsed = parseCatalogArchiveHtml(html, 'movie');

    assert.equal(parsed.sliderMovies.length, 7);
    assert.equal(parsed.sliderMovies[0].title, 'Espermagedom');
    assert.equal(parsed.sliderMovies[0].year, '2024');
    assert.ok(parsed.sliderMovies[0].backdrop.includes('/t/p/w1280/'));

    assert.equal(parsed.items.length, 30);
    assert.equal(parsed.items[0].kind, 'movie');
    assert.equal(parsed.items[0].quality, 'FHD');
    assert.equal(parsed.currentPage, 1);
    assert.equal(parsed.totalPages, 7);
  });

  it('recognizes ADIADO alongside HIATO in homepage calendar items', () => {
    const html = `
      <div id="dt-seasons">
        <article class="item">
          <div class="poster">
            <img src="https://image.tmdb.org/t/p/w185/op.jpg" alt="One Piece" />
            <div class="adiado_layer"><span class="adiado_text">ADIADO</span></div>
          </div>
          <div class="data"><h3><a href="https://topanimes.net/animes/one-piece/">One Piece</a></h3><span>1999</span></div>
        </article>
        <article class="item">
          <div class="poster">
            <img src="https://image.tmdb.org/t/p/w185/h.jpg" alt="Hiato Anime" />
            <div class="adiado_layer"><span class="adiado_text">HIATO</span></div>
          </div>
          <div class="data"><h3><a href="https://topanimes.net/animes/hiato-anime/">Hiato Anime</a></h3><span>2026</span></div>
        </article>
      </div>`;
    const home = parseHomeHtml(html, 'live');
    assert.equal(home.calendar.length, 2);
    assert.equal(home.calendar[0].isHiatus, true);
    assert.equal(home.calendar[0].statusBadge, 'Adiado');
    assert.equal(home.calendar[1].isHiatus, true);
    assert.equal(home.calendar[1].statusBadge, 'Hiato');
  });

  it('separates alternativeTitle from year, extracts #info custom_fields/MAL, and parses .se-cu seasons', () => {
    const html = `
      <div class="sheader">
        <div class="poster"><img src="https://image.tmdb.org/t/p/w500/p.jpg" /></div>
        <div class="data">
          <h1>Kusuriya no Hitorigoto 3</h1>
          <div class="extra"><span class="date" itemprop="dateCreated">The Apothecary Diaries Season 3</span></div>
        </div>
      </div>
      <span class="dt_rating_vgs">8.7</span>
      <div id="info">
        <div class="wp-content"><p>Terceira temporada.</p></div>
        <div class="custom_fields"><b class="variante">Título original</b><span class="valor">薬屋のひとりごと</span></div>
        <div class="custom_fields"><b class="variante">Classificação TMDb</b><span class="valor"><b id="repimdb"><strong>8.6</strong> 644 votos</b></span></div>
        <div class="custom_fields"><b class="variante">Data de estreia</b><span class="valor">22/10/23</span></div>
        <div class="custom_fields"><b class="variante">Data do último episódio</b><span class="valor">04/07/25</span></div>
        <div class="custom_fields"><b class="variante">Temporadas</b><span class="valor">1</span></div>
        <div class="custom_fields"><b class="variante">Episódios</b><span class="valor">60</span></div>
        <div class="custom_fields"><b class="variante">Duração média</b><span class="valor">23 minutos</span></div>
        <div class="custom_fields"><b class="variante">Links</b><span class="valor2"><a href="https://myanimelist.net/anime/61987">MAL</a></span></div>
      </div>
      <seasons data="https://topanimes.net/animes/kusuriya-no-hitorigoto/"></seasons>
      <div id="seasons">
        <div class="se-c"><div class="se-a"><ul class="episodios">
          <li><div class="numerando">3 - 1</div><div class="epnumber">1</div><div class="episodiotitle"><a href="https://topanimes.net/episodio/kusuriya-3-ep-1/">Episódio 1</a></div></li>
        </ul></div></div>
        <div class="se-cu"><div class="se-a"><ul class="episodios">
          <li><div class="numerando">3 - 2</div><div class="epnumber">2</div><div class="episodiotitle"><a href="https://topanimes.net/episodio/kusuriya-3-ep-2/">Episódio 2</a></div></li>
        </ul></div></div>
      </div>`;

    const anime = parseAnimePageHtml(html, 'https://topanimes.net/animes/kusuriya-no-hitorigoto-3/');
    assert.equal(anime.alternativeTitle, 'The Apothecary Diaries Season 3');
    assert.equal(anime.originalTitle, '薬屋のひとりごと');
    assert.equal(anime.year, '2023');
    assert.equal(anime.rating, '8.7');
    assert.equal(anime.tmdbRating, '8.6');
    assert.equal(anime.tmdbVotes, '644 votos');
    assert.equal(anime.firstAirDate, '22/10/23');
    assert.equal(anime.lastAirDate, '04/07/25');
    assert.equal(anime.seasonsCount, '1');
    assert.equal(anime.episodesTotalCount, '60');
    assert.equal(anime.averageDuration, '23 minutos');
    assert.equal(anime.myAnimeListUrl, 'https://myanimelist.net/anime/61987');
    assert.equal(anime.allSeasonsUrl, 'https://topanimes.net/animes/kusuriya-no-hitorigoto/');
    assert.equal(anime.episodes.length, 2);
    assert.equal(anime.episodes[1].episodeNumber, 2);
  });

  it('parses /calendario/ weekly sections with normalized labels and ratings', () => {
    const calHtml = `
      <div id="archive-content" class="animation-2 items">
        <header><h2>Calendário de Hoje</h2></header>
        <div class="items featured">
          <article class="item tvshows">
            <div class="poster"><img src="https://image.tmdb.org/t/p/w185/a.jpg" alt="Dreamland" /><div class="rating">0</div></div>
            <div class="data"><h3><a href="https://topanimes.net/animes/dreamland/">Dreamland</a></h3><span>2026</span></div>
          </article>
        </div>
        <header><h2>Sabado</h2></header>
        <div class="items featured">
          <article class="item tvshows">
            <div class="poster"><img src="https://image.tmdb.org/t/p/w185/b.jpg" alt="Frieren Dublado" /><div class="rating">8.718</div></div>
            <div class="data"><h3><a href="https://topanimes.net/animes/frieren-dublado/">Frieren Dublado</a></h3><span>2026</span></div>
          </article>
        </div>
      </div>`;
    const cal = parseCalendarPageHtml(calHtml, 'live');
    assert.equal(cal.days.length, 2);
    assert.equal(cal.days[0].id, 'hoje');
    assert.equal(cal.days[0].isToday, true);
    assert.equal(cal.days[0].items[0].rating, undefined);
    assert.equal(cal.days[1].id, 'sabado');
    assert.equal(cal.days[1].label, 'Sábado');
    assert.equal(cal.days[1].items[0].rating, '8.7');
    assert.equal(cal.days[1].items[0].audioType, 'DUB');
  });

  it('extracts DooPlay nonce, AJAX player fallback options, search/glossary JSON, and filters new ad domains', () => {
    const html = `
      <script>
        var dtGonza = {"api":"https://topanimes.net/wp-json/dooplay/search/","glossary":"https://topanimes.net/wp-json/dooplay/glossary/","nonce":"84ea18fe09"};
        var dtAjax = {"url":"/wp-admin/admin-ajax.php","player_api":"https://topanimes.net/wp-json/dooplayer/v2/","play_method":"admin_ajax"};
      </script>
      <ul id="playeroptionsul">
        <li class="dooplay_player_option" data-post="666510" data-type="tv" data-nume="1"><span class="title">KojimaCDN</span></li>
        <li class="dooplay_player_option" data-post="666510" data-type="tv" data-nume="2"><span class="title">Zuplay</span></li>
        <li class="dooplay_player_option" data-post="666510" data-type="tv" data-nume="5"><span class="title">aniplay</span></li>
      </ul>
      <div id="source-player-1"><iframe src="https://topanimes.net/antivirus2/yes/?id=ok"></iframe></div>
      <div id="source-player-2"></div>`;

    assert.equal(extractDooPlayNonce(html), '84ea18fe09');
    const ajaxCfg = extractDooPlayAjaxConfig(html);
    assert.equal(ajaxCfg.ajaxUrl, 'https://topanimes.net/wp-admin/admin-ajax.php');
    assert.equal(ajaxCfg.playMethod, 'admin_ajax');

    const missing = extractMissingDooPlayerOptions(html);
    assert.equal(missing.length, 1);
    assert.deepEqual(missing[0], { post: '666510', nume: '2', type: 'tv', label: 'Zuplay' });

    assert.equal(
      parseDooPlayerAjaxResponse(
        JSON.stringify({
          embed_url: '<iframe src="https://topanimes.net/aviso/?url=https%3A%2F%2Fcsst.online%2Fembed%2F123"></iframe>',
          type: 'dtshcode',
        })
      ),
      'https://csst.online/embed/123'
    );

    const wpSearch = parseWpSearchJson({
      '10': {
        title: 'Kusuriya no Hitorigoto 3',
        url: 'https://topanimes.net/animes/kusuriya-no-hitorigoto-3/',
        img: 'https://image.tmdb.org/t/p/w92/k.jpg',
        extra: { date: false, imdb: '8.7' },
      },
    });
    assert.equal(wpSearch.length, 1);
    assert.equal(wpSearch[0].year, undefined);
    assert.equal(wpSearch[0].rating, '8.7');

    const glossary = parseWpGlossaryJson({
      '1': {
        title: 'Ao no Hako Dublado',
        url: 'https://topanimes.net/animes/ao-no-hako-dublado/',
        img: 'https://image.tmdb.org/t/p/w185/ao.jpg',
        year: '2025',
        imdb: '8.4',
      },
    });
    assert.equal(glossary.length, 1);
    assert.equal(glossary[0].audioType, 'DUB');
    assert.equal(glossary[0].rating, '8.4');

    const filteredEmbed = extractStreamsFromEmbed(
      'https://topanimes.net/antivirus2/yes/?id=test',
      `
        const ad1 = "https://cvt-s2.agl004.fun/promo.mp4";
        const ad2 = "https://viewanalitycs.org/v.m3u8";
        const ad3 = "https://www.metilinksemvoce.site/video.mp4";
        const real = "https://doce-de-leite-vegano.b-cdn.net/real/cdn_stream.m3u8?token=ok&expires=1795286692";
      `
    );
    assert.equal(filteredEmbed.streams.length, 1);
    assert.ok(filteredEmbed.streams[0].url.includes('doce-de-leite-vegano.b-cdn.net'));
  });

  it('parses TopAnimes .se-cu compact episode grid (Frieren layout without .episodiotitle) and splits composite alternativeTitle aliases', () => {
    const html = `
      <div class="sheader">
        <div class="poster"><img src="https://image.tmdb.org/t/p/w500/frieren.jpg" /></div>
        <div class="data">
          <h1>Sousou no Frieren</h1>
          <div class="extra"><span class="date">Ore dake Level Up na Ken | Na Honjaman Level Up, I Level Up Alone</span></div>
        </div>
      </div>
      <div id="seasons">
        <div class="se-cu">
          <div class="se-q"></div>
          <div class="capitulos_list on-visited se-a" style="display:block">
            <ul class="episodios">
              <li class="item-1">
                <div style="display:none" class="epnumber">1</div>
                <a title="Sousou no Frieren - Episódio 1 Online" href="https://topanimes.net/episodio/sousou-no-frieren-episodio-1/">1</a>
              </li>
              <li class="item-28">
                <div style="display:none" class="epnumber">28</div>
                <a title="Sousou no Frieren - Episódio 28 Online" href="https://topanimes.net/episodio/sousou-no-frieren-episodio-28/">28</a>
              </li>
            </ul>
          </div>
        </div>
      </div>`;

    const anime = parseAnimePageHtml(html, 'https://topanimes.net/animes/sousou-no-frieren/');
    assert.equal(anime.episodes.length, 2);
    assert.equal(anime.episodes[0].episodeNumber, 1);
    assert.equal(anime.episodes[0].seasonNumber, 1);
    assert.equal(anime.episodes[0].title, 'Episódio 1');
    assert.equal(anime.episodes[0].url, 'https://topanimes.net/episodio/sousou-no-frieren-episodio-1/');
    assert.equal(anime.episodes[1].episodeNumber, 28);
    assert.equal(anime.episodes[1].title, 'Episódio 28');
    assert.deepEqual(anime.alternativeTitles, [
      'Ore dake Level Up na Ken',
      'Na Honjaman Level Up',
      'I Level Up Alone',
    ]);
  });

  it('unpacks Dean Edwards packed MixDrop scripts and extracts protocol-relative MDCore.wurl MP4 and poster', () => {
    const mixdropHtml = `
      <html><body><script>
        eval(function(p,a,c,k,e,d){e=function(c){return c};if(!''.replace(/^/,String)){while(c--){d[c]=k[c]||c}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('1.31="//4-3.8.2/30/7.29";1.28=" ";1.27="//4-3.8.2/26/7.6?25=24-23&22=21&20=19";1.18="17.6";1.16="4-3";1.15="";1.14=0;1.13="";1.12="11%10%5%9.2%5";',10,32,'|MDCore|net|delivery31|a|2F|mp4|pkd3x7wjcq4p3p|mxcontent|2Ftopanimes|3A|https|referrer|adTagUrl|chromeInject|remotesub|vserver|774680c43f14016b39274168cb54d992|vfile|1795696037|_t|1795716320|e|RBhQ|qwzUGVYZYgeowuFi2|s|v2|wurl|furl|jpg|thumbs|poster'.split('|'),0,{}))
      </script></body></html>
    `;

    const extracted = extractStreamsFromEmbed(
      'https://mixdrop.ag/e/pkd3x7wjcq4p3p',
      mixdropHtml
    );
    assert.equal(extracted.provider, 'MixDrop');
    assert.equal(extracted.streams.length, 1);
    assert.equal(
      extracted.streams[0].url,
      'https://a-delivery31.mxcontent.net/v2/pkd3x7wjcq4p3p.mp4?s=qwzUGVYZYgeowuFi2-RBhQ&e=1795716320&_t=1795696037'
    );
    assert.equal(extracted.streams[0].format, 'mp4');
    assert.equal(
      extracted.poster,
      'https://a-delivery31.mxcontent.net/thumbs/pkd3x7wjcq4p3p.jpg'
    );
  });

  it('preserves fractional recap episode numbers (7.5 vs 7) so they do not collide with Episode 7', () => {
    const html = `
      <div class="sheader"><div class="data"><h1>Solo Leveling</h1></div></div>
      <div id="seasons">
        <div class="se-cu">
          <div class="se-q"><span class="se-t">1</span><span class="title">Temporada 1</span></div>
          <div class="se-a">
            <ul class="episodios">
              <li>
                <div class="numerando">1 - 7.5</div>
                <div class="epnumber">7.5</div>
                <div class="episodiotitle"><a href="https://topanimes.net/episodio/solo-leveling-episodio-7-5/">Episódio 7.5</a></div>
              </li>
              <li>
                <div class="numerando">1 - 7</div>
                <div class="epnumber">7</div>
                <div class="episodiotitle"><a href="https://topanimes.net/episodio/solo-leveling-episodio-7/">Episódio 7</a></div>
              </li>
            </ul>
          </div>
        </div>
      </div>`;

    const anime = parseAnimePageHtml(html, 'https://topanimes.net/animes/upando-sozinho/');
    assert.equal(anime.episodes.length, 2);
    assert.equal(anime.episodes[0].episodeNumber, 7.5);
    assert.equal(anime.episodes[0].url, 'https://topanimes.net/episodio/solo-leveling-episodio-7-5/');
    assert.equal(anime.episodes[1].episodeNumber, 7);
    assert.equal(anime.episodes[1].url, 'https://topanimes.net/episodio/solo-leveling-episodio-7/');
  });
});

