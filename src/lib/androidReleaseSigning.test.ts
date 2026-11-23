import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

// Regression: installing a new APK over the old one failed with "package already exists /
// conflicts with an existing package". Android only accepts an update when the new APK is
// signed with the same key and does not have a lower versionCode. The CI used to publish the
// debug build, signed with a debug keystore that is regenerated on every fresh runner.
describe('android/app/build.gradle - release signing and versioning', () => {
  const gradle = read('android/app/build.gradle');

  it('signs the release build type with a dedicated signing config', () => {
    assert.match(gradle, /signingConfigs\s*\{\s*release\s*\{/);
    assert.match(gradle, /signingConfig(?:\s*=|\s+)\s*signingConfigs\.release/);
  });

  it('reads the keystore location and credentials from environment variables', () => {
    for (const name of [
      'ANDROID_KEYSTORE_PATH',
      'ANDROID_KEYSTORE_PASSWORD',
      'ANDROID_KEY_ALIAS',
      'ANDROID_KEY_PASSWORD',
    ]) {
      assert.match(gradle, new RegExp(`System\\.getenv\\('${name}'\\)`), `${name} is not read`);
    }
  });

  it('never hard-codes keystore credentials', () => {
    assert.doesNotMatch(gradle, /(storePassword|keyPassword|keyAlias)\s+['"][^'"]+['"]/);
    assert.doesNotMatch(gradle, /storeFile\s+file\(['"]/);
  });

  it('does not sign the release build with the debug keystore', () => {
    assert.doesNotMatch(gradle, /signingConfigs\.debug/);
  });

  it('derives versionCode and versionName from the CI instead of hard-coding them', () => {
    assert.match(gradle, /System\.getenv\('APP_VERSION_CODE'\)/);
    assert.match(gradle, /System\.getenv\('APP_VERSION_NAME'\)/);
    assert.match(gradle, /versionCode\s+appVersionCode/);
    assert.match(gradle, /versionName\s+appVersionName/);
    assert.doesNotMatch(gradle, /versionCode\s+\d+/);
  });
});

describe('signing keys are never committed', () => {
  const gitignore = read('.gitignore')
    .split('\n')
    .map((line) => line.trim());

  it('.gitignore blocks keystore files', () => {
    assert.ok(gitignore.includes('*.keystore'));
    assert.ok(gitignore.includes('*.jks'));
    assert.ok(gitignore.includes('keystore.properties'));
  });
});

describe('package.json scripts', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('offers a local release build next to the debug one', () => {
    assert.match(pkg.scripts['apk:release'], /gradlew assembleRelease/);
    assert.match(pkg.scripts['apk:build'], /gradlew assembleDebug/);
  });
});
