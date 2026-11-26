#!/usr/bin/env bash
set -euo pipefail

# Fetches (with SHA-256 verification) or builds the latest stable release of
# yt-dlp directly from https://github.com/yt-dlp/yt-dlp.git and bundles it into
# Android resources (`android/app/src/main/res/raw/ytdlp`), plus writes version
# metadata (`android/app/src/main/assets/download-engines.json`).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RAW_DIR="$ROOT_DIR/android/app/src/main/res/raw"
ASSETS_DIR="$ROOT_DIR/android/app/src/main/assets"

YTDLP_REPO="https://github.com/yt-dlp/yt-dlp.git"
ARIA2_REPO="https://github.com/aria2/aria2.git"
YTDLP_TAG="${1:-${YTDLP_TAG:-}}"
ARIA2_TAG="${2:-${ARIA2_TAG:-}}"

if [ -z "$YTDLP_TAG" ] || [ -z "$ARIA2_TAG" ]; then
  RESOLVED_JSON="$(node "$SCRIPT_DIR/resolve-download-engines.mjs" --json)"
  if [ -z "$YTDLP_TAG" ]; then
    YTDLP_TAG="$(printf '%s' "$RESOLVED_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d.ytdlpTag);")"
  fi
  if [ -z "$ARIA2_TAG" ]; then
    ARIA2_TAG="$(printf '%s' "$RESOLVED_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d.aria2Tag);")"
  fi
fi

mkdir -p "$RAW_DIR" "$ASSETS_DIR"
TMP_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ytdlp-fetch-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

YTDLP_OUT="$TMP_DIR/yt-dlp"
DL_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/yt-dlp"
SHA_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/SHA2-256SUMS"

echo "=== Obtendo yt-dlp estável (${YTDLP_TAG}) de ${YTDLP_REPO} ==="
FETCHED=0
if curl -fsSL --retry 3 "$DL_URL" -o "$YTDLP_OUT" && curl -fsSL --retry 3 "$SHA_URL" -o "$TMP_DIR/SHA2-256SUMS"; then
  EXPECTED_SHA="$(node -e "
    const fs = require('fs');
    const txt = fs.readFileSync(process.argv[1], 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
      if (m && m[2].trim().replace(/^\.\//, '') === 'yt-dlp') {
        process.stdout.write(m[1].toLowerCase());
        process.exit(0);
      }
    }
  " "$TMP_DIR/SHA2-256SUMS")"
  ACTUAL_SHA="$(sha256sum "$YTDLP_OUT" | awk '{print tolower($1)}')"
  if [ -n "$EXPECTED_SHA" ] && [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
    echo "SHA-256 de yt-dlp ${YTDLP_TAG} verificado com sucesso (${ACTUAL_SHA})."
    FETCHED=1
  else
    echo "::warning::SHA-256 divergente (esperado=${EXPECTED_SHA}, obtido=${ACTUAL_SHA}). Compilando diretamente da tag Git."
    rm -f "$YTDLP_OUT"
  fi
fi

if [ "$FETCHED" -ne 1 ]; then
  echo "Compilando zipapp yt-dlp diretamente do repositório git ${YTDLP_REPO} (${YTDLP_TAG})..."
  git clone --depth 1 --branch "$YTDLP_TAG" "$YTDLP_REPO" "$TMP_DIR/yt-dlp-src"
  pushd "$TMP_DIR/yt-dlp-src" >/dev/null
  python3 devscripts/make_lazy_extractors.py || true
  make yt-dlp
  cp yt-dlp "$YTDLP_OUT"
  popd >/dev/null
fi

if [ ! -s "$YTDLP_OUT" ]; then
  echo "::error::Binário zipapp yt-dlp vazio ou ausente."
  exit 1
fi

cp "$YTDLP_OUT" "$RAW_DIR/ytdlp"
chmod 0644 "$RAW_DIR/ytdlp"
ls -lh "$RAW_DIR/ytdlp"

# Record exact bundled versions for runtime diagnostics & auto-update checks
node -e "
  const fs = require('fs');
  const meta = {
    aria2Tag: process.argv[1],
    aria2Version: process.argv[1].replace(/^release-/, ''),
    aria2Repo: '${ARIA2_REPO}',
    ytdlpTag: process.argv[2],
    ytdlpVersion: process.argv[2],
    ytdlpRepo: '${YTDLP_REPO}',
    maxConnectionsPerServer: 16,
    maxSplits: 32,
    maxConcurrentSegments: 16,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(process.argv[3], JSON.stringify(meta, null, 2) + '\n', 'utf8');
" "$ARIA2_TAG" "$YTDLP_TAG" "$ASSETS_DIR/download-engines.json"

echo "=== Metadados gravados em $ASSETS_DIR/download-engines.json ==="
cat "$ASSETS_DIR/download-engines.json"
