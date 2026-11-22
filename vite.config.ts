import { execSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

const rootDir = import.meta.dirname;

function readBuildInfo() {
  let pkgVersion = '1.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'package.json'), 'utf8')) as {
      version?: string;
    };
    if (pkg.version && pkg.version !== '0.0.0') {
      pkgVersion = pkg.version;
    }
  } catch {
    // fallback
  }

  let commitSha = (process.env.GITHUB_SHA || '').trim();
  if (!commitSha) {
    try {
      commitSha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      commitSha = '';
    }
  }

  let builtAt = '';
  if (commitSha) {
    try {
      builtAt = execSync('git log -1 --format=%cI', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      builtAt = '';
    }
  }
  if (!builtAt) {
    builtAt = new Date().toISOString();
  }

  const version = (process.env.APP_VERSION_NAME || '').trim() || pkgVersion;
  return {
    version,
    commitSha,
    builtAt,
    repository: 'Martin01683/Aplicativo-de-animes',
  };
}

export default defineConfig(() => {
  const buildInfo = readBuildInfo();
  return {
    define: {
      __APP_BUILD_INFO__: JSON.stringify(buildInfo),
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'icon.svg',
          'apple-touch-icon.png',
          'pwa-192x192.png',
          'pwa-512x512.png',
          'pwa-maskable-512x512.png',
        ],
        devOptions: {
          enabled: true,
          type: 'module',
          suppressWarnings: true,
        },
        manifest: {
          id: '/',
          name: 'Anisync — Animes',
          short_name: 'Anisync',
          description:
            'Catálogo direto dos servidores integrados com metadados do TheTVDB e calendário semanal de animes do LiveChart.me.',
          theme_color: '#0d0f12',
          background_color: '#0d0f12',
          display: 'standalone',
          orientation: 'any',
          lang: 'pt-BR',
          start_url: '/',
          scope: '/',
          categories: ['entertainment', 'video'],
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          navigateFallbackDenylist: [/^\/api\//, /^\/downloads\//, /\.apk$/i],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'google-fonts-stylesheets',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-webfonts',
                expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /\/api\/(home|anime|media|catalog|calendar)$/i,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'anisync-catalog-cache',
                networkTimeoutSeconds: 4,
                expiration: { maxEntries: 30, maxAgeSeconds: 60 * 15 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(rootDir, 'dist');
          const srcAssets = path.resolve(rootDir, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
