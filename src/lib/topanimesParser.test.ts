import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  extractStreamsFromEmbed,
  parseAnimePageHtml,
  parseCatalogArchiveHtml,
  parseEpisodePageHtml,
  parseEpisodesArchiveHtml,
  parseHomeHtml,
  parseSearchHtml,
  parseSearchPageHtml,
  parseWpSearchJson,
} from './topanimesParser.ts';
import { isSafeExternalHttpUrl, isTopAnimesUrl, unwrapAvisoUrl } from './urlSafety.ts';

const ROOT = process.cwd();
const HOME_CAPTURE = path.join(
  ROOT,
  'public/assets/aistudio/captura-topanimes.net-20261120-185536_c8f54b4e.html'
);
const EPISODE_CAPTURE = path.join(
  ROOT,
  'public/assets/aistudio/captura-topanimes.net-20261120-185622_7446cc49.html'
);
const EPISODES_ARCHIVE_CAPTURE = path.join(
  ROOT,
  'public/assets/aistudio/captura-topanimes.net-20261120-193317_58010c0a.html'
);
const SEARCH_CAPTURE = path.join(
  ROOT,
  'public/assets/aistudio/captura-topanimes.net-20261120-193320_0ff36db0.html'
);
const ANIMES_ARCHIVE_CAPTURE = path.join(
  ROOT,
  'public/assets/aistudio/captura-topanimes.net-20261120-194623_978b4a6c.html'
);
const MOVIES_ARCHIVE_CAPTURE = path.join(
  ROOT,
  'public/assets/aistudio/captura-topanimes.net-20261120-194902_e963a754.html'
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
      ['KojimaCDN', 'Zuplay', 'Vidstreaming', 'ruplay']
    );
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
});
