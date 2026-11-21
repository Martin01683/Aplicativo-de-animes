# Changelog

Todas as alterações relevantes do **TopAnimes** são documentadas abaixo e geradas automaticamente nas notas de cada release no GitHub.

## [Não lançado]

### Novidades
- Calendário semanal completo (`/calendario/`) com abas de Hoje e Domingo a Sábado e exibição de notas (`ca98d84`)
- Busca instantânea (autocomplete) via API JSON do site (`/wp-json/dooplay/search/`) (`ca98d84`)
- Navegação alfabética A–Z no catálogo (`/wp-json/dooplay/glossary/`) (`ca98d84`)
- Metadados completos na página do anime (título alternativo, título original, estreia, último episódio, duração média, TMDb, link do MyAnimeList e link para todas as temporadas) (`ca98d84`)
- Controles na lista de episódios: busca por número/título, ordenação crescente/decrescente e atalho para o último episódio (`ca98d84`)
- Geração automática de changelog nas releases do GitHub Actions

### Correções
- Desmascaramento de segmentos MPEG-TS do KojimaCDN e prevenção de tela preta no LibVLC no Android (`696c129`)
- Restauração da superfície de vídeo do LibVLC ao retornar de outro aplicativo no Android (`8c111e1`)
- Parser JW Player (`sources`/`tracks`) no resolver Android para detectar 1080p imediatamente no KojimaCDN (`ca98d84`)
- Separação entre título alternativo e ano na página do anime, detecção do selo `ADIADO`, suporte a `#seasons .se-cu`, expiração/invalidação do cache de links assinados (`b-cdn.net`), fallback `doo_player_ajax` / `wp-json` e filtro ampliado de domínios de anúncio (`ca98d84`)
- Padronização dos nomes de servidores com inicial maiúscula (ex.: `Ruplay`, `Aniplay`)
- Remoção dos avisos do servidor `npm run dev` (`08573c9`), avisos `react-hooks/exhaustive-deps` em `AnimePlayer.tsx` e avisos de depreciação de Node 20 nas actions do CI

---

## [v1.0.10] — 2026-11-21 (`5f36e78`)
### Novidades
- Marcação de episódios e temporadas como vistos (`5f36e78`)
- Interface cancelável de download e atualização do APK (`5f36e78`)

## [v1.0.9] — 2026-11-21 (`25f76a1`)
### Correções
- Persistência do modo de escala do vídeo e retomada do progresso de reprodução dos episódios (`25f76a1`)

## [v1.0.8] — 2026-11-21 (`b0f47ab`)
### Novidades
- Navegação personalizada do botão Voltar e instalador nativo de APK com verificação (`d80f943`)
### Correções
- Correção na instalação do APK e ajustes no layout de atualização (`b0f47ab`)

## [v1.0.7] — 2026-11-21 (`c446eb5`)
### Correções
- Ajuste no layout mobile do intervalo de atualização e tempo de pular abertura fixo em 85s (`c446eb5`)
- Empilhamento vertical do controle de pular abertura no mobile (`0cc3d06`)

## [v1.0.6] — 2026-11-21 (`47a7a6a`)
### Correções
- Gestos de brilho e volume por arraste no Android, toque duplo confiável de ±5s e dica compacta de gestos (`47a7a6a`)
### Melhorias e Manutenção
- CI passa a criar uma release versionada (`v1.0.x`) por build em vez de sobrescrever `latest-apk` (`3ec4fea`)

## [latest-apk] — 2026-11-21 (`c05e367`)
### Novidades
- Aplicativo inicial, projeto Android Capacitor, plugin `LocalProxy` e player nativo LibVLC embutido (`1868b8c`, `1ac2ac8`, `51588e9`)
- Modal de configurações, atualizador via GitHub Releases, UI unificada do player Android e navegação entre episódios em tela cheia (`c05e367`)
### Correções
- Publicação de APK de release assinado com chave fixa para permitir atualizações sobre versões anteriores (`7ea7c80`)
