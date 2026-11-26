# Changelog

Todas as alterações relevantes do **Anisync** são geradas automaticamente a partir dos commits de cada release.

## [v1.0.39] — 2026-11-26

### Correções
- Corrige falso positivo de nova versão no fallback Atom e na comparação SemVer (`0131bad`)

### Melhorias e Manutenção
- Adiciona guarda de pre-push para workflows, scripts shell, OpenSSL e Java (`79dd9c6`)

## [v1.0.38] — 2026-11-26

### Novidades
- Adiciona downloads offline em fila com aria2c em velocidade máxima e yt-dlp sempre atualizados (`f1b3bc7`)
- Adiciona suporte nativo ao servidor Aniplay/Abyss no Web e Android (`0db5e66`)
- Switch TV cast skip to 5s, add 1% hold volume buttons, and save JSON backups to Android Downloads (`eb5d979`)

### Correções
- Remove flag no-docs incompatível com OpenSSL 3.0 ao compilar aria2c para Android (`564585c`)
- Sincroniza volume real da TV antes de iniciar e corrige bug de seek voltando ao 0:00 no Android (`e449838`)
- Adiciona fallback anti-403/429 no verificador de atualizações e corrige posição do rodapé do changelog (`a9b3ffb`)
- Keep TV cast controls accessible, support live server switching, and prevent DLNA clock reset after seek (`8426d71`)

## [v1.0.36] — 2026-11-26

### Novidades
- TV Cast em segundo plano, DeepL, TheTVDB/TheXEM, MyAnimeList, backup JSON e melhorias no atualizador (`b8363c0`)
- Prioritize TheTVDB profile, fix TopAnimes/MixDrop/HinataSoul detection, and persist calendar layout (`f561bb6`)

### Correções
- Resolve CI lint and npm warnings, localize language/country to PT-BR, and fix TV cast seekbar scrubbing (`4dd8ae3`)

### Melhorias e Manutenção
- Atualiza descrições de TheTVDB, MyAnimeList e LiveChart.me em Configurações (`97b50dc`)
- Exibe botão Ler sinopse completa apenas quando há texto truncado (`7f1ffb5`)
- Unifica tags de mídia, áudio e gêneros do TheTVDB na página do episódio e remove botão Todas as temporadas (`177e623`)

## [v1.0.35] — 2026-11-24

### Novidades
- Reorganize anime profile layout (Style A) and eagerly hydrate PT-BR episode titles with loading skeleton (`15648d2`)

## [v1.0.34] — 2026-11-24

### Correções
- Eliminate +5s seek jump-back by blocking VLC 3.0 TimeCallback echo and stale mid-seek updates (`6e308cc`)

### Melhorias e Manutenção
- Upgrade Gradle wrapper to 9.9.2 and AGP to 9.5.2 (`e666d5d`)

## [v1.0.33] — 2026-11-24

### Correções
- Load official TheTVDB PT-BR episode titles directly with shared cache and clean Japanese brackets (`c740e15`)

## [v1.0.32] — 2026-11-24

### Novidades
- Option 2 Crunchyroll-style episode cards, Sem censura badge, and PT-BR episode title translation (`52f800e`)

## [v1.0.31] — 2026-11-24

### Novidades
- Separate DUB and LEG audio tracks with switcher tabs and audio-scoped playback (`8515d6d`)

## [v1.0.30] — 2026-11-24

### Correções
- Match notification small icon silhouette exactly to the Anisync app logo (`8538d5e`)

## [v1.0.29] — 2026-11-24

### Correções
- Use exact LibVLC seek and directional TimeChanged guard so +5s forward skips never jump backward (`63dbf87`)

## [v1.0.28] — 2026-11-24

### Correções
- Only record episodes in watch history after video playback actually starts (`17d655d`)
- Keep 'Marcar temporada como vista' below season header on mobile single-season tabs (`8c9c800`)

## [v1.0.27] — 2026-11-24

### Correções
- Disable long-press haptic vibration, text selection, and drag/contextmenu callouts on cards (`e805494`)

## [v1.0.26] — 2026-11-24

### Correções
- Standardize card footer into two fixed rows to prevent tag truncation (`0331399`)

## [v1.0.25] — 2026-11-24

### Correções
- Add monochrome Anisync small icon for system notifications (`66e8a5c`)
- Standardize season cards, deduplicate player menu and episode notices, and auto-exit fullscreen at series end (`e15c5a5`)
- Compact card footer tags onto a single balanced row (`ab18843`)
- Unify multi-season arc entries and improve TheTVDB season alignment (`35df0cf`)

### Melhorias e Manutenção
- Remove 1/5 min intervals, notification sound, and quiet hours options (`8966a04`)

## [v1.0.24] — 2026-11-23

### Novidades
- Add Sonarr-style collapsible seasons with Expandir tudo / Recolher tudo (`020c042`)
- Unify all anime seasons on a single page with season tabs and cross-season playback (`2c8da55`)

### Correções
- Label undated episodes as 'A ser anunciada' and ignore TV network names / TBA placeholders (`2d7896a`)

## [v1.0.23] — 2026-11-23

### Novidades
- Add anime synopses with Google Translate, prioritize TheTVDB artwork, and move episode synopsis/button above actions (`ed97e98`)

### Correções
- Eliminate LibVLC audio dropouts on seek and pause/resume (`7926bbd`)

## [v1.0.22] — 2026-11-23

### Correções
- Upgrade Capacitor 8, Android SDK 36, latest dependencies, and fix build warnings (`43f897b`)

### Melhorias e Manutenção
- Update libvlc-all from 3.6.5 to 3.7.8 (`7610162`)

## [v1.0.20] — 2026-11-23

### Melhorias e Manutenção
- Rename server to provider and update episode logic (`3c689b1`)

## [v1.0.19] — 2026-11-23

### Novidades
- Clarify that release dates and countdowns reflect official launch forecasts (`e0ce697`)

## [v1.0.18] — 2026-11-23

### Novidades
- Show complete episode guide with release dates, live countdowns, and improved server matching (`576785e`)
- Overhaul notification center, native Android delivery, quiet hours, and per-anime mute (`acb26c1`)

### Correções
- Remove update dot from settings gear, scroll update actions to download panel, and boost calendar countdown contrast (`becca84`)

## [v1.0.17] — 2026-11-22

### Novidades
- Hide full UI during double-tap side seek leaving only progress bar and seek delta (`d71a724`)

### Correções
- Serve zero-WebSocket Vite client shim when DISABLE_HMR is enabled (`2f5b3c8`)

## [v1.0.16] — 2026-11-22

### Novidades
- Add real buffered progress bar to native Android LibVLC and web players (`ac8be16`)

## [v1.0.15] — 2026-11-22

### Melhorias e Manutenção
- Move test fixtures out of public/ and exclude public/assets/aistudio from Vite builds (`e68c1f4`)

## [v1.0.14] — 2026-11-22

### Correções
- Serialize ServerOption embedUrl and providerKind in VlcPlayerActivity (`8f9042d`)
- Preserve active playback on screen-off reopen and reliably sync watch history (`d95d587`)

### Melhorias e Manutenção
- Remove unused AI Studio chat attachments and ignore future uploads (`503ec56`)
- Add pre-push build checks and Android Java static guard tests (`007b248`)

## [v1.0.13] — 2026-11-22

### Novidades
- Rebrand to Anisync, add Hinata Soul source, history management, and faster episode loading (`ec35b3f`)

## [v1.0.12] — 2026-11-21

### Correções
- Show subtitle/audio track language instead of raw LibVLC 'Track N' (`9bcab10`)
- Prevent infinite startup update check loop and repeated toast (`fe4927e`)
- Separate subtitle/audio player menus and startup update check toggle (`ab6a0af`)
- Prevent runaway auto-advance on premature stream EOF (`92efa5a`)

## [v1.0.11] — 2026-11-21

### Novidades
- Add weekly calendar, autocomplete, A-Z glossary, rich metadata and JW Player/DooPlay AJAX improvements (`584c19f`)

### Correções
- Stack audio filter and catalog selects vertically on mobile in SettingsModal (`f9033ba`)
- Capitalize server names, auto-generate release changelog, and clear CI/ESLint warnings (`df77cc8`)
- Unmask KojimaCDN MPEG-TS segments and prevent LibVLC black screen (`bed432a`)
- Restore LibVLC video surface when returning from another app (`248ec09`)

### Melhorias e Manutenção
- Suppress dev-dist glob warning in VitePWA devOptions (`e2fbed6`)
- Auto-regenerate CHANGELOG.md from git commits on every release (`7739458`)
- Fix Vite __dirname and deprecated server.hmr.server warnings (`1e7b2b0`)

## [v1.0.10] — 2026-11-21

### Novidades
- Watched episode/season toggles and cancelable APK update UI (`c819234`)

## [v1.0.9] — 2026-11-21

### Correções
- Persist video scale and resume episode playback progress (`5cc1245`)

## [v1.0.8] — 2026-11-21

### Novidades
- Implement custom back navigation and APK installer (`e3c1f55`)

### Melhorias e Manutenção
- Fix APK installation and update UI layout (`dbb5b8c`)

## [v1.0.7] — 2026-11-21

### Correções
- Fix update interval mobile layout and keep skip intro fixed at 85s (`f7800c0`)
- Stack Tempo do botão Pular Abertura vertically on mobile (`ce08086`)

## [v1.0.6] — 2026-11-21

### Novidades
- Add settings modal, GitHub updater, unified Android player UI, and in-fullscreen episode navigation (`5f354a3`)

### Correções
- Add brightness/volume swipe, reliable double-tap +/-5s, and compact gesture hint (`dfad735`)
- Publish a signed release APK so updates install over the old app (`ec6317c`)

### Melhorias e Manutenção
- Create a new versioned GitHub release per build instead of overwriting latest-apk (`554b693`)

## [latest-apk] — 2026-11-21

### Novidades
- Embed LibVLC native player and disable desktop shortcuts on Android (`1007095`)
- Add Capacitor Android project, LocalProxy plugin, and compiled APK (`245ca9c`)
- Setup project structure and main application (`0408d19`)

### Correções
- Grant contents: write to the release job in the reusable workflow (`dff9a93`)
- Resolve npm peer dependency conflict in GitHub Actions build (`1c5699d`)

### Melhorias e Manutenção
- Update workflow structure test for the separate publish job (`ef9dbef`)
- Add husky, gitleaks, eslint, prettier, and reusable CI workflow (`3278368`)
- Add GitHub Actions workflow for automatic Android APK build (`4075fea`)
- Initial commit (`43319f8`)

