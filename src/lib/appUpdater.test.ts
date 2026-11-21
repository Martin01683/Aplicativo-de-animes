import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReleaseIdentityKey,
  compareSemver,
  evaluateUpdateStatus,
  extractCommitShaFromNotes,
  formatBytes,
  isAllowedGitHubDownloadUrl,
  isCancelledApkProgressEvent,
  normalizeSha256Digest,
  parseGitHubReleasePayload,
  reduceApkDownloadProgress,
} from './appUpdater';

const SAMPLE_RELEASE_PAYLOAD = {
  id: 453376005,
  tag_name: 'latest-apk',
  target_commitish: '1150bf005d7585ecc192709d986330c2f0f78020',
  name: 'TopAnimes Android APK',
  html_url: 'https://github.com/Martin01683/Aplicativo-de-animes/releases/tag/latest-apk',
  published_at: '2026-11-21T02:11:00Z',
  updated_at: '2026-11-21T02:42:12Z',
  body: 'Build automático (release assinado) gerado após validação (7ea7c809c1317142fa6c3aa4818e9716afbfe30c).',
  assets: [
    {
      name: 'TopAnimes.apk',
      size: 92044913,
      updated_at: '2026-11-21T02:42:11Z',
      digest: 'sha256:848ba2a9b672e15b1ebb42b3ccbf7f9c3340f5ea3e71370fd36ae213dc00be3b',
      browser_download_url:
        'https://github.com/Martin01683/Aplicativo-de-animes/releases/download/latest-apk/TopAnimes.apk',
    },
  ],
};

test('extractCommitShaFromNotes and parseGitHubReleasePayload extract real release metadata', () => {
  assert.equal(
    extractCommitShaFromNotes(SAMPLE_RELEASE_PAYLOAD.body),
    '7ea7c809c1317142fa6c3aa4818e9716afbfe30c'
  );

  const parsed = parseGitHubReleasePayload(SAMPLE_RELEASE_PAYLOAD);
  assert.ok(parsed);
  assert.equal(parsed.tagName, 'latest-apk');
  assert.equal(parsed.releaseName, 'TopAnimes Android APK');
  assert.equal(parsed.commitSha, '7ea7c809c1317142fa6c3aa4818e9716afbfe30c');
  assert.equal(parsed.apkAsset?.name, 'TopAnimes.apk');
  assert.equal(parsed.apkAsset?.sizeBytes, 92044913);
  assert.equal(parsed.updatedAt, '2026-11-21T02:42:11Z');
});

test('isAllowedGitHubDownloadUrl blocks non-github and non-https URLs', () => {
  assert.equal(
    isAllowedGitHubDownloadUrl(
      'https://github.com/Martin01683/Aplicativo-de-animes/releases/download/latest-apk/TopAnimes.apk'
    ),
    true
  );
  assert.equal(
    isAllowedGitHubDownloadUrl('https://objects.githubusercontent.com/some-release/TopAnimes.apk'),
    true
  );
  assert.equal(isAllowedGitHubDownloadUrl('http://github.com/foo/bar.apk'), false);
  assert.equal(isAllowedGitHubDownloadUrl('https://evil.example.com/TopAnimes.apk'), false);
});

test('compareSemver compares versions accurately', () => {
  assert.equal(compareSemver('v1.0.5', '1.0.4'), 1);
  assert.equal(compareSemver('1.0.5', 'v1.0.5'), 0);
  assert.equal(compareSemver('1.0.2', '1.1.0'), -1);
});

test('evaluateUpdateStatus handles matching commit, newer release timestamp, and semver tags', () => {
  const parsed = parseGitHubReleasePayload(SAMPLE_RELEASE_PAYLOAD)!;

  const sameCommit = evaluateUpdateStatus({
    currentBuild: {
      version: '1.0.10',
      commitSha: '7ea7c809c1317142fa6c3aa4818e9716afbfe30c',
      builtAt: '2026-11-21T02:34:07Z',
      repository: 'Martin01683/Aplicativo-de-animes',
    },
    remoteRelease: parsed,
  });
  assert.equal(sameCommit.hasUpdate, false);
  assert.equal(sameCommit.reason, 'up-to-date');

  const newerRemoteBuild = evaluateUpdateStatus({
    currentBuild: {
      version: '1.0.9',
      commitSha: '1111111111111111111111111111111111111111',
      builtAt: '2026-11-20T20:00:00Z',
      repository: 'Martin01683/Aplicativo-de-animes',
    },
    remoteRelease: parsed,
  });
  assert.equal(newerRemoteBuild.hasUpdate, true);
  assert.equal(newerRemoteBuild.reason, 'newer-release-build');

  const acknowledged = evaluateUpdateStatus({
    currentBuild: {
      version: '1.0.9',
      commitSha: '1111111111111111111111111111111111111111',
      builtAt: '2026-11-20T20:00:00Z',
      repository: 'Martin01683/Aplicativo-de-animes',
    },
    remoteRelease: parsed,
    acknowledgedReleaseKey: buildReleaseIdentityKey(parsed),
  });
  assert.equal(acknowledged.hasUpdate, false);

  const olderRemoteBuild = evaluateUpdateStatus({
    currentBuild: {
      version: '1.0.11',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      builtAt: '2026-11-21T04:30:00Z',
      repository: 'Martin01683/Aplicativo-de-animes',
    },
    remoteRelease: parsed,
  });
  assert.equal(olderRemoteBuild.hasUpdate, false);

  const semverUpdate = evaluateUpdateStatus({
    currentBuild: {
      version: '1.0.10',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      builtAt: '2026-11-21T04:30:00Z',
      repository: 'Martin01683/Aplicativo-de-animes',
    },
    remoteRelease: {
      ...parsed,
      tagName: 'v1.1.0',
    },
  });
  assert.equal(semverUpdate.hasUpdate, true);
  assert.equal(semverUpdate.reason, 'newer-version');
});

test('formatBytes formats APK sizes cleanly', () => {
  assert.equal(formatBytes(92044913), '87.8 MB');
  assert.equal(formatBytes(512_000), '500 KB');
  assert.equal(formatBytes(0), '—');
});

test('normalizeSha256Digest parses prefixed and raw 64-hex digests and rejects invalid input', () => {
  assert.equal(
    normalizeSha256Digest(
      'sha256:848BA2A9B672E15B1EBB42B3CCBF7F9C3340F5EA3E71370FD36AE213DC00BE3B'
    ),
    '848ba2a9b672e15b1ebb42b3ccbf7f9c3340f5ea3e71370fd36ae213dc00be3b'
  );
  assert.equal(
    normalizeSha256Digest('848ba2a9b672e15b1ebb42b3ccbf7f9c3340f5ea3e71370fd36ae213dc00be3b'),
    '848ba2a9b672e15b1ebb42b3ccbf7f9c3340f5ea3e71370fd36ae213dc00be3b'
  );
  assert.equal(normalizeSha256Digest('sha256:short'), '');
  assert.equal(normalizeSha256Digest(''), '');
  assert.equal(normalizeSha256Digest(undefined), '');
});

test('isCancelledApkProgressEvent and reduceApkDownloadProgress clear cancelled notices immediately', () => {
  assert.equal(
    isCancelledApkProgressEvent({
      stage: 'cancelled',
      message: 'Atualização cancelada.',
    }),
    true
  );
  assert.equal(
    isCancelledApkProgressEvent({
      stage: 'error',
      message: 'Instalação cancelada pelo usuário.',
    }),
    true
  );
  assert.equal(
    isCancelledApkProgressEvent({
      stage: 'error',
      message: 'Falha na verificação SHA-256 do APK baixado.',
    }),
    false
  );

  const cancelled = reduceApkDownloadProgress({
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
    stage: 'cancelled',
    message: 'Instalação cancelada pelo usuário.',
  });
  assert.equal(cancelled.progress, null);
  assert.equal(cancelled.downloading, false);
  assert.equal(cancelled.toastMessage, 'Instalação cancelada pelo usuário.');

  const legacyAborted = reduceApkDownloadProgress({
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
    stage: 'error',
    message: 'Instalação cancelada pelo usuário.',
  });
  assert.equal(legacyAborted.progress, null);
  assert.equal(legacyAborted.downloading, false);
  assert.equal(legacyAborted.toastMessage, 'Instalação cancelada pelo usuário.');

  const downloading = reduceApkDownloadProgress({
    downloadedBytes: 12_000_000,
    totalBytes: 88_000_000,
    percent: 14,
    stage: 'downloading',
  });
  assert.equal(downloading.downloading, true);
  assert.equal(downloading.progress?.percent, 14);
  assert.equal(downloading.toastMessage, undefined);

  const installed = reduceApkDownloadProgress({
    downloadedBytes: 88_000_000,
    totalBytes: 88_000_000,
    percent: 100,
    stage: 'installed',
  });
  assert.equal(installed.downloading, false);
  assert.equal(installed.acknowledgeRelease, true);
  assert.equal(installed.toastMessage, 'Atualização instalada com sucesso!');

  const failed = reduceApkDownloadProgress({
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
    stage: 'error',
    message: 'Falha ao instalar atualização no sistema.',
  });
  assert.equal(failed.downloading, false);
  assert.equal(failed.progress?.stage, 'error');
  assert.equal(failed.toastMessage, 'Falha ao instalar atualização no sistema.');
});
