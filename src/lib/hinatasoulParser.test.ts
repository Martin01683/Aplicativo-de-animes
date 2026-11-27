import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanHinataSoulSeriesTitle,
  deriveHinataSoulR2Candidates,
  extractHinataSoulEpisodeNumber,
  extractHinataSoulSeasonNumber,
  fixHinataSoulMojibake,
  parseHinataSoulAnimePageHtml,
  parseHinataSoulCatalogHtml,
  parseHinataSoulEpisodePageHtml,
  parseHinataSoulHomeHtml,
  parseHinataSoulSearchHtml,
} from './hinatasoulParser.ts';

describe('hinatasoulParser', () => {
  it('repairs UTF-8-as-Windows-1252 mojibake in synopses while preserving valid UTF-8', () => {
    const broken =
      'ApÃ³s o Exame de Mago de Primeira Classe, o trio â€“ o mago Ã©lfico Frieren â€‹â€‹avanÃ§a.';
    assert.equal(
      fixHinataSoulMojibake(broken),
      'Após o Exame de Mago de Primeira Classe, o trio – o mago élfico Frieren avança.'
    );
    assert.equal(
      fixHinataSoulMojibake('Sinopse já correta em português — episódio 1.'),
      'Sinopse já correta em português — episódio 1.'
    );
  });

  it('extracts season numbers and episode numbers accurately', () => {
    assert.equal(extractHinataSoulSeasonNumber('Sousou no Frieren 2nd Season'), 2);
    assert.equal(extractHinataSoulSeasonNumber('Sousou no Frieren 2nd Season - Dublado'), 2);
    assert.equal(extractHinataSoulSeasonNumber('Sousou no Frieren'), 1);
    assert.equal(extractHinataSoulSeasonNumber('Shiguang Dailiren III - Dublado'), 3);
    assert.equal(extractHinataSoulSeasonNumber('Kimetsu no Yaiba 2: Yuukaku-hen'), 2);
    assert.equal(extractHinataSoulEpisodeNumber('Episódio 01'), 1);
    assert.equal(extractHinataSoulEpisodeNumber('Sousou no Frieren 2nd Season ep 10'), 10);
    assert.equal(extractHinataSoulEpisodeNumber('Naruto Shippuden ep 1-2'), 1);
  });

  it('parses the Frieren 2nd Season anime page HTML without mixing recommended cards into episodes', () => {
    const frierenHtml = `
      <html><body>
        <div class="tituloPage"><div class="mwidth"><h1>Sousou no Frieren 2nd Season</h1></div></div>
        <div class="mainSingle mwidth">
          <div class="left">
            <div class="aniInfosSingle">
              <div class="aniInfosSingleCapa">
                <img src="https://www.hinatasoul.com/media/categories/video/35aab6a4ded5a7ad9e539622d6c30632.jpg" alt="Sousou no Frieren 2nd Season" />
              </div>
              <div class="aniInfosSingleNums">
                <div class="aniInfosSingleNumsItem"><b>Episódios</b> 0/??</div>
                <div class="aniInfosSingleNumsItem"><b>Ano</b> 2026</div>
                <div class="aniInfosSingleNumsItem"><b>Tipo</b> TV</div>
              </div>
              <div class="aniInfosSingleInfoItem"><b>Título Alternativo</b><span>Frieren: Beyond Journey's End Season 2</span></div>
              <div class="aniInfosSingleInfoItem"><b>Autor</b><span>Desconhecido</span></div>
              <div class="aniInfosSingleInfoItem"><b>Estúdio</b><span>Madhouse</span></div>
              <div class="aniInfosSingleGeneros"><b>Gêneros</b><span>Aventura</span><span>Drama</span><span>Fantasia</span></div>
              <div class="aniInfosSingleSinopse"><b>Sinopse</b><p>ApÃ³s o Exame de Mago de Primeira Classe, o trio â€“ o mago Ã©lfico Frieren.</p></div>
            </div>
            <div><a href="https://myanimelist.net/anime/59978/" class="tempProxima">MyAnimeList</a></div>
          </div>
          <div class="right">
            <div class="aniContainer">
              <div class="ultimosEpisodiosHomeItem">
                <a href="/videos/538184" title="Sousou no Frieren 2nd Season ep 1">
                  <div class="ultimosEpisodiosHomeItemImg"><img src="https://www.hinatasoul.com/media/videos/tmb/538184/1.jpg" /></div>
                  <div class="ultimosEpisodiosHomeItemInfos">
                    <div class="ultimosEpisodiosHomeItemInfosNome">Sousou no Frieren 2nd Season ep 1</div>
                    <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 01</div>
                  </div>
                  <div class="lancaster_episodio_info_data">16/01/2026 às 12:16</div>
                </a>
              </div>
              <div class="ultimosEpisodiosHomeItem">
                <a href="/videos/544685" title="Sousou no Frieren 2nd Season ep 10">
                  <div class="ultimosEpisodiosHomeItemImg"><img src="https://www.hinatasoul.com/media/videos/tmb/544685/1.jpg" /></div>
                  <div class="ultimosEpisodiosHomeItemInfos">
                    <div class="ultimosEpisodiosHomeItemInfosNome">Sousou no Frieren 2nd Season ep 10</div>
                    <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 10</div>
                  </div>
                  <div class="lancaster_episodio_info_data">27/03/2026 às 20:46</div>
                </a>
              </div>
            </div>
            <div class="letterBox"><div class="mwidth">
              <a href="https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season/page/1">1</a>
              <a href="https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season/page/2">2</a>
            </div></div>
            <div class="cbox">
              <div class="ultimosAnimesHomeItem">
                <a href="/animes/5f7d55809b35178f5be64480dadf57fe89362c08">
                  <div class="ultimosAnimesHomeItemImg"><img src="https://www.hinatasoul.com/media/categories/video/s1.jpg" /></div>
                  <div class="ultimosAnimesHomeItemInfos"><div class="ultimosAnimesHomeItemInfosNome">Sousou no Frieren</div></div>
                </a>
              </div>
            </div>
          </div>
        </div>
        <div class="letterBox"><div class="mwidth">
          <a href="https://www.hinatasoul.com/animes/letra/a">a</a>
          <a href="https://www.hinatasoul.com/animes/letra/z">z</a>
        </div></div>
      </body></html>
    `;

    const parsed = parseHinataSoulAnimePageHtml(
      frierenHtml,
      'https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season'
    );
    assert.equal(parsed.totalPages, 2);
    assert.equal(parsed.details.title, 'Sousou no Frieren 2nd Season');
    assert.equal(parsed.details.alternativeTitle, "Frieren: Beyond Journey's End Season 2");
    assert.equal(parsed.details.year, '2026');
    assert.equal(parsed.details.studio, 'Madhouse');
    assert.deepEqual(parsed.details.genres, ['Aventura', 'Drama', 'Fantasia']);
    assert.equal(
      parsed.details.synopsis,
      'Após o Exame de Mago de Primeira Classe, o trio – o mago élfico Frieren.'
    );
    assert.equal(parsed.details.myAnimeListUrl, 'https://myanimelist.net/anime/59978/');
    assert.equal(parsed.details.audioType, 'LEG');
    assert.equal(parsed.details.sourceServerName, 'Hinata Soul');
    assert.equal(parsed.details.episodes.length, 2);
    assert.equal(parsed.details.episodes[0].url, 'https://www.hinatasoul.com/videos/538184');
    assert.equal(parsed.details.episodes[0].episodeNumber, 1);
    assert.equal(parsed.details.episodes[0].seasonNumber, 2);
    assert.equal(parsed.details.episodes[1].episodeNumber, 10);
    assert.equal(parsed.details.relations?.length, 1);
  });

  it('parses episode page HTML and derives R2 bucket candidates for iphonec and iphoneb', () => {
    const epHtml = `
      <html>
        <head><meta property="og:image" content="https://www.hinatasoul.com/media/videos/tmb/538184/default.webp" /></head>
        <body>
          <h1 class="epTituloNome">Sousou no Frieren 2nd Season ep 2</h1>
          <meta itemprop="contentURL" content="https://static.merceriadajoanasd21.online/iphonec/538568.mp4" />
          <div class="AbasBox">
            <div class="Aba active" aba-type="0" data-target="0">SD</div>
            <div class="Aba" aba-type="1" data-target="1">HD</div>
            <div class="Aba" aba-type="2" data-target="2">FULLHD</div>
          </div>
          <div class="videoBox">
            <div class="playerContainer" id="0"><a href="https://fatshark.xyz/filez5.php?t=sd"></a></div>
            <div class="playerContainer" id="1"><a href="https://fatshark.xyz/filez5.php?t=hd"></a></div>
            <div class="playerContainer" id="2"><a href="https://fatshark.xyz/filez5.php?t=fhd"></a></div>
          </div>
          <div class="controlesBox">
            <div class="controlesBoxItem"><a href="https://www.hinatasoul.com/videos/538184" title="Episódio Anterior">Anterior</a></div>
            <div class="controlesBoxItem"><a href="https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season" title="Lista de Episódios">Lista</a></div>
            <div class="controlesBoxItem"><a href="https://www.hinatasoul.com/videos/538870" title="Próximo Episódio">Próximo</a></div>
          </div>
        </body>
      </html>
    `;

    const { episode, contentUrl, qualities } = parseHinataSoulEpisodePageHtml(
      epHtml,
      'https://www.hinatasoul.com/videos/538568'
    );
    assert.equal(episode.title, 'Sousou no Frieren 2nd Season ep 2');
    assert.equal(episode.seriesTitle, 'Sousou no Frieren 2nd Season');
    assert.equal(
      episode.seriesUrl,
      'https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season'
    );
    assert.equal(episode.prevUrl, 'https://www.hinatasoul.com/videos/538184');
    assert.equal(episode.nextUrl, 'https://www.hinatasoul.com/videos/538870');
    assert.equal(episode.seasonNumber, 2);
    assert.equal(episode.episodeNumber, 2);
    assert.equal(episode.options.length, 1);
    assert.equal(episode.options[0].providerKind, 'hinatasoul');
    assert.equal(episode.options[0].embedUrl, 'https://www.hinatasoul.com/videos/538568');

    const r2New = deriveHinataSoulR2Candidates(contentUrl, qualities);
    assert.deepEqual(
      r2New.map((c) => [c.height, c.r2Url]),
      [
        [1080, 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/zful/538568.mp4'],
        [720, 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z333/538568.mp4'],
        [480, 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphonec/538568.mp4'],
      ]
    );

    const r2Legacy = deriveHinataSoulR2Candidates(
      'https://static.merceriadajoanasd21.online/iphoneb/49547.mp4',
      [
        { target: '0', label: 'SD', height: 480 },
        { target: '1', label: 'HD', height: 720 },
      ]
    );
    assert.deepEqual(
      r2Legacy.map((c) => [c.height, c.r2Url]),
      [
        [720, 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/z222/49547.mp4'],
        [480, 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/ziphoneb/49547.mp4'],
      ]
    );
  });

  it('parses Hinata Soul home, catalog, and search HTML with pagination and audio tags', () => {
    const homeHtml = `
      <html><body>
        <div class="tituloContainer"><div class="titulo">Últimos episódios em lançamento</div></div>
        <div class="epiContainer">
          <div class="ultimosEpisodiosHomeItem">
            <a href="/videos/589748" title="Frieren 2 ep 8">
              <div class="ultimosEpisodiosHomeItemImg"><img src="https://www.hinatasoul.com/media/videos/tmb/589748/1.jpg" /></div>
              <div class="ultimosEpisodiosHomeItemInfos">
                <div class="ultimosEpisodiosHomeItemInfosNome"><h1>Sousou no Frieren 2nd Season ep 8</h1></div>
                <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 08</div>
              </div>
            </a>
          </div>
        </div>
        <div class="tituloContainer"><div class="titulo">Últimos Animes Dublados Adicionados</div></div>
        <div class="epiContainer">
          <div class="ultimosAnimesHomeItem">
            <a href="/anime-dublado/sousou-no-frieren-2nd-season-dublado">
              <div class="ultimosAnimesHomeItemImg"><img src="https://www.hinatasoul.com/media/categories/video/frieren2.jpg" /></div>
              <div class="ultimosAnimesHomeItemInfos">
                <div class="ultimosAnimesHomeItemInfosNome">Sousou no Frieren 2nd Season - Dublado</div>
                <div class="ultimosAnimesHomeItemTipo">Anime Dublado</div>
                <div class="ultimosAnimesHomeItemQntEps">10/10 Episódios</div>
              </div>
            </a>
          </div>
        </div>
      </body></html>
    `;

    const home = parseHinataSoulHomeHtml(homeHtml, 'live');
    assert.equal(home.releases.length, 1);
    assert.equal(home.releases[0].title, 'Sousou no Frieren 2nd Season');
    assert.equal(home.releases[0].episodeLabel, 'Episódio 08');
    assert.equal(home.releases[0].sourceServerName, 'Hinata Soul');
    assert.equal(home.animes.length, 1);
    assert.equal(home.animes[0].audioType, 'DUB');
    assert.equal(
      home.animes[0].url,
      'https://www.hinatasoul.com/anime-dublado/sousou-no-frieren-2nd-season-dublado'
    );

    const searchHtml = `
      <html><body>
        <div class="ultimosAnimesHomeItem">
          <a href="https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season">
            <div class="ultimosAnimesHomeItemImg"><img src="https://www.hinatasoul.com/media/categories/video/f2.jpg" /></div>
            <div class="ultimosAnimesHomeItemInfos">
              <div class="ultimosAnimesHomeItemInfosNome">Sousou no Frieren 2nd Season</div>
            </div>
          </a>
        </div>
        <div class="letterBox"><div class="mwidth">
          <a href="/busca?busca=frieren&page=1">1</a>
          <a href="/busca?busca=frieren&page=3">3</a>
        </div></div>
      </body></html>
    `;

    const search = parseHinataSoulSearchHtml(searchHtml, 1);
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].audioType, 'LEG');
    assert.equal(search.totalPages, 3);

    const catalog = parseHinataSoulCatalogHtml(searchHtml, 'anime', null, 1);
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.totalPages, 3);
  });

  it('extracts season 2 from space-separated TopAnimes Dublado titles and strips trailing Online/subtitles from series titles', () => {
    assert.equal(extractHinataSoulSeasonNumber('Sousou no Frieren 2 Dublado'), 2);
    assert.equal(extractHinataSoulSeasonNumber('Sousou no Frieren 2 Legendado'), 2);
    assert.equal(extractHinataSoulSeasonNumber('Sousou no Frieren 2nd Season - Dublado'), 2);
    assert.equal(extractHinataSoulSeasonNumber('Sousou no Frieren Dublado'), 1);

    assert.equal(
      cleanHinataSoulSeriesTitle('Sousou no Frieren Episódio 1 Online'),
      'Sousou no Frieren'
    );
    assert.equal(
      cleanHinataSoulSeriesTitle('Sousou no Frieren - Dublado Episódio 1 Full HD'),
      'Sousou no Frieren - Dublado'
    );
    assert.equal(
      cleanHinataSoulSeriesTitle('Sousou no Frieren Episódio 1 - O fim da aventura'),
      'Sousou no Frieren'
    );
  });
});
