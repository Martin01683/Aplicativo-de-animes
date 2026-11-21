# Changelog

Todas as alterações relevantes do **TopAnimes** são geradas automaticamente a partir dos commits de cada release.

## [Não lançado]

### Novidades
- Add weekly calendar, autocomplete, A-Z glossary, rich metadata and JW Player/DooPlay AJAX improvements (`ca98d84`)

### Correções
- Capitalize server names, auto-generate release changelog, and clear CI/ESLint warnings (`6bd6e59`)
- Unmask KojimaCDN MPEG-TS segments and prevent LibVLC black screen (`696c129`)
- Restore LibVLC video surface when returning from another app (`8c111e1`)

### Melhorias e Manutenção
- Fix Vite __dirname and deprecated server.hmr.server warnings (`08573c9`)

## [v1.0.10] — 2026-11-21

### Novidades
- Watched episode/season toggles and cancelable APK update UI (`5f36e78`)

## [v1.0.9] — 2026-11-21

### Correções
- Persist video scale and resume episode playback progress (`25f76a1`)

## [v1.0.8] — 2026-11-21

### Novidades
- Implement custom back navigation and APK installer (`d80f943`)

### Melhorias e Manutenção
- Fix APK installation and update UI layout (`b0f47ab`)

## [v1.0.7] — 2026-11-21

### Correções
- Fix update interval mobile layout and keep skip intro fixed at 85s (`c446eb5`)
- Stack Tempo do botão Pular Abertura vertically on mobile (`0cc3d06`)

## [v1.0.6] — 2026-11-21

### Novidades
- Add settings modal, GitHub updater, unified Android player UI, and in-fullscreen episode navigation (`c05e367`)

### Correções
- Add brightness/volume swipe, reliable double-tap +/-5s, and compact gesture hint (`47a7a6a`)
- Publish a signed release APK so updates install over the old app (`7ea7c80`)

### Melhorias e Manutenção
- Create a new versioned GitHub release per build instead of overwriting latest-apk (`3ec4fea`)

## [latest-apk] — 2026-11-21

### Novidades
- Embed LibVLC native player and disable desktop shortcuts on Android (`51588e9`)
- Add Capacitor Android project, LocalProxy plugin, and compiled APK (`1ac2ac8`)
- Setup project structure and main application (`1868b8c`)

### Correções
- Grant contents: write to the release job in the reusable workflow (`54b4d91`)
- Resolve npm peer dependency conflict in GitHub Actions build (`9e3a0a8`)

### Melhorias e Manutenção
- Update workflow structure test for the separate publish job (`1150bf0`)
- Add husky, gitleaks, eslint, prettier, and reusable CI workflow (`7b221ac`)
- Add GitHub Actions workflow for automatic Android APK build (`e74d662`)
- Initial commit (`6ae0f5c`)

