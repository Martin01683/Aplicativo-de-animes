# Changelog

Todas as alterações relevantes do **Anisync** são geradas automaticamente a partir dos commits de cada release.

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

