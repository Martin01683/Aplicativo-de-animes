import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decideAndroidCheckAction,
  detectAndroidSdkDir,
  getGradleWrapperCommand,
  hasAndroidChanges,
  parseLocalPropertiesSdkDir,
} from '../../scripts/check-android-build.mjs';
import { resolveBufferedEndSec } from './playerBuffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const JAVA_DIR = resolve(ROOT, 'android/app/src/main/java/com/topanimes/player');

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

function stripJavaCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // String literal
    if (ch === '"') {
      out += '""';
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Char literal
    if (ch === "'") {
      out += "''";
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function extractBalancedBlock(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }
  throw new Error(`Unbalanced braces starting at index ${openBraceIndex}`);
}

function extractJavaClassFields(source: string, className: string): Set<string> {
  const clean = stripJavaCommentsAndStrings(source);
  const classRegex = new RegExp(`\\bclass\\s+${className}\\b[^{]*\\{`);
  const match = classRegex.exec(clean);
  assert.ok(match, `Expected to find Java class ${className}`);

  const openBraceIdx = match.index + match[0].length - 1;
  const body = extractBalancedBlock(clean, openBraceIdx);

  // Collect only top-level declarations inside the class (brace depth 0 within body)
  let topLevel = '';
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      depth++;
      topLevel += ';';
    } else if (ch === '}') {
      depth--;
    } else if (depth === 0) {
      topLevel += ch;
    }
  }

  const fields = new Set<string>();
  for (const rawStmt of topLevel.split(';')) {
    const stmt = rawStmt.trim();
    if (!stmt || stmt.includes('(')) continue;
    const beforeAssign = stmt.split('=')[0].trim();
    const fieldMatch = beforeAssign.match(/\b([A-Za-z_]\w*)$/);
    if (fieldMatch) {
      fields.add(fieldMatch[1]);
    }
  }
  return fields;
}

function extractJavaMethodBody(source: string, methodName: string): string {
  const regex = new RegExp(`\\b${methodName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = regex.exec(source);
  assert.ok(match, `Expected to find Java method ${methodName}()`);
  const openBraceIdx = match.index + match[0].length - 1;
  return extractBalancedBlock(source, openBraceIdx);
}

function extractJsonPutKeys(methodBody: string): Set<string> {
  const keys = new Set<string>();
  for (const match of methodBody.matchAll(/\.put\(\s*"([^"]+)"\s*,/g)) {
    keys.add(match[1]);
  }
  return keys;
}

function extractJsonReadKeys(methodBody: string): Set<string> {
  const keys = new Set<string>();
  for (const match of methodBody.matchAll(
    /\.(?:optString|optInt|optLong|optBoolean|getString|getInt|getLong|getBoolean|has|isNull)\(\s*"([^"]+)"/g,
  )) {
    keys.add(match[1]);
  }
  return keys;
}

interface InvalidFieldAccess {
  className: string;
  varName: string;
  fieldName: string;
}

function findInvalidJavaFieldAccesses(
  source: string,
  knownClassFields: Map<string, Set<string>>,
): InvalidFieldAccess[] {
  const clean = stripJavaCommentsAndStrings(source);
  const typeAlternation = [...knownClassFields.keys()]
    .map((name) => `(?:TopAnimesEpisodeResolver\\.)?${name}`)
    .join('|');

  const errors: InvalidFieldAccess[] = [];
  const seen = new Set<string>();

  // Match enhanced-for loops: `for (final? Type var : ...)` and scan their loop body
  const forLoopRegex = new RegExp(
    `for\\s*\\(\\s*(?:final\\s+)?(${typeAlternation})\\s+([a-zA-Z_]\\w*)\\s*:[^)]*\\)\\s*\\{`,
    'g',
  );

  for (const match of clean.matchAll(forLoopRegex)) {
    const rawType = match[1];
    const className = rawType.split('.').pop()!;
    const varName = match[2];
    const allowedFields = knownClassFields.get(className);
    if (!allowedFields) continue;

    const openBraceIdx = match.index! + match[0].length - 1;
    const loopBody = extractBalancedBlock(clean, openBraceIdx);
    const accessRegex = new RegExp(`(?<!\\.)\\b${varName}\\.([a-zA-Z_]\\w*)\\b(?!\\s*\\()`, 'g');

    for (const access of loopBody.matchAll(accessRegex)) {
      const fieldName = access[1];
      if (!allowedFields.has(fieldName)) {
        const key = `${className}:${varName}.${fieldName}`;
        if (!seen.has(key)) {
          seen.add(key);
          errors.push({ className, varName, fieldName });
        }
      }
    }
  }

  // Match method parameters: `private void foo(final? Type var, ...) { ... }`
  const methodRegex = new RegExp(
    `(?:public|private|protected)\\s+(?:static\\s+)?[\\w<>\\[\\].]+\\s+[a-zA-Z_]\\w*\\s*\\(([^)]*)\\)\\s*\\{`,
    'g',
  );
  const paramTypeRegex = new RegExp(`(?:final\\s+)?(${typeAlternation})\\s+([a-zA-Z_]\\w*)\\b`, 'g');

  for (const m of clean.matchAll(methodRegex)) {
    const paramsText = m[1];
    const typedParams = [...paramsText.matchAll(paramTypeRegex)];
    if (typedParams.length === 0) continue;

    const openBraceIdx = m.index! + m[0].length - 1;
    const methodBody = extractBalancedBlock(clean, openBraceIdx);

    for (const p of typedParams) {
      const className = p[1].split('.').pop()!;
      const varName = p[2];
      const allowedFields = knownClassFields.get(className);
      if (!allowedFields) continue;

      const accessRegex = new RegExp(`(?<!\\.)\\b${varName}\\.([a-zA-Z_]\\w*)\\b(?!\\s*\\()`, 'g');
      for (const access of methodBody.matchAll(accessRegex)) {
        const fieldName = access[1];
        if (!allowedFields.has(fieldName)) {
          const key = `${className}:${varName}.${fieldName}`;
          if (!seen.has(key)) {
            seen.add(key);
            errors.push({ className, varName, fieldName });
          }
        }
      }
    }
  }

  return errors;
}

describe('Android Java compile-time guard (static symbol & serialization checks)', () => {
  const resolverJava = readFileSync(resolve(JAVA_DIR, 'TopAnimesEpisodeResolver.java'), 'utf8');
  const activityJava = readFileSync(resolve(JAVA_DIR, 'VlcPlayerActivity.java'), 'utf8');
  const pluginJava = readFileSync(resolve(JAVA_DIR, 'NativeVlcPlayerPlugin.java'), 'utf8');

  const knownClassFields = new Map<string, Set<string>>([
    ['StreamCandidate', extractJavaClassFields(resolverJava, 'StreamCandidate')],
    ['SubtitleCandidate', extractJavaClassFields(resolverJava, 'SubtitleCandidate')],
    ['ServerOption', extractJavaClassFields(resolverJava, 'ServerOption')],
    ['EpisodeLink', extractJavaClassFields(resolverJava, 'EpisodeLink')],
    ['ResolvedEmbedData', extractJavaClassFields(resolverJava, 'ResolvedEmbedData')],
    ['ResolvedEpisodeData', extractJavaClassFields(resolverJava, 'ResolvedEpisodeData')],
    ['StreamItem', extractJavaClassFields(activityJava, 'StreamItem')],
    ['SubtitleItem', extractJavaClassFields(activityJava, 'SubtitleItem')],
    ['VisitedEpisodeState', extractJavaClassFields(activityJava, 'VisitedEpisodeState')],
    ['ProbeOutcome', extractJavaClassFields(activityJava, 'ProbeOutcome')],
  ]);

  it('verifies all field accesses on Android data models exist in their Java class definitions', () => {
    assert.deepEqual(
      [...(knownClassFields.get('ServerOption') ?? [])].sort(),
      ['embedUrl', 'label', 'nume', 'providerKind'],
    );

    const activityErrors = findInvalidJavaFieldAccesses(activityJava, knownClassFields);
    assert.deepEqual(
      activityErrors,
      [],
      `Invalid Java field accesses in VlcPlayerActivity.java: ${JSON.stringify(activityErrors)}`,
    );

    const resolverErrors = findInvalidJavaFieldAccesses(resolverJava, knownClassFields);
    assert.deepEqual(
      resolverErrors,
      [],
      `Invalid Java field accesses in TopAnimesEpisodeResolver.java: ${JSON.stringify(resolverErrors)}`,
    );
  });

  it('catches non-existent ServerOption fields like opt.postId / opt.postType / opt.ajaxUrl', () => {
    const brokenSnippet = `
      private String serializeOptionsJson() {
        for (TopAnimesEpisodeResolver.ServerOption opt : serverOptions) {
          o.put("postId", opt.postId);
          o.put("postType", opt.postType);
          o.put("ajaxUrl", opt.ajaxUrl);
        }
      }
    `;
    const errors = findInvalidJavaFieldAccesses(brokenSnippet, knownClassFields);
    assert.deepEqual(
      errors.map((e) => e.fieldName),
      ['postId', 'postType', 'ajaxUrl'],
    );
  });

  it('keeps serialize*Json and parse*Json keys aligned in VlcPlayerActivity.java', () => {
    const pairs: Array<[string, string]> = [
      ['serializeStreamsJson', 'parseStreamsJson'],
      ['serializeSubtitlesJson', 'parseSubtitlesJson'],
      ['serializeEpisodesJson', 'parseEpisodesJson'],
      ['serializeOptionsJson', 'parseOptionsJson'],
      ['buildVisitedEpisodesJsonArray', 'parseVisitedEpisodesJson'],
    ];

    for (const [serializer, parser] of pairs) {
      const serKeys = extractJsonPutKeys(extractJavaMethodBody(activityJava, serializer));
      const parseKeys = extractJsonReadKeys(extractJavaMethodBody(activityJava, parser));
      assert.ok(serKeys.size > 0, `${serializer} should serialize at least one JSON key`);
      for (const key of parseKeys) {
        assert.ok(
          serKeys.has(key),
          `${serializer}() is missing key "${key}" required by ${parser}()`,
        );
      }
    }

    const optKeys = extractJsonPutKeys(extractJavaMethodBody(activityJava, 'serializeOptionsJson'));
    assert.deepEqual([...optKeys].sort(), ['embedUrl', 'label', 'nume', 'providerKind']);
  });

  it('ensures every VlcPlayerActivity EXTRA_* / RESULT_* constant used by NativeVlcPlayerPlugin is declared', () => {
    const referencedConstants = new Set<string>();
    for (const match of pluginJava.matchAll(/VlcPlayerActivity\.((?:EXTRA|RESULT)_[A-Z0-9_]+)/g)) {
      referencedConstants.add(match[1]);
    }
    assert.ok(referencedConstants.size > 0);
    for (const constantName of referencedConstants) {
      const declRegex = new RegExp(`public\\s+static\\s+final\\s+String\\s+${constantName}\\s*=`);
      assert.match(
        activityJava,
        declRegex,
        `NativeVlcPlayerPlugin references VlcPlayerActivity.${constantName}, which is not declared`,
      );
    }
  });
});

describe('Pre-push build checks and Android Gradle gate', () => {
  it('wires .husky/pre-push and package.json to run full web + Android build checks before push', () => {
    const prePushHook = readRepoFile('.husky/pre-push');
    const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };
    const scriptSource = readRepoFile('scripts/check-android-build.mjs');

    assert.match(prePushHook, /npm run prepush:check/);
    assert.match(pkg.scripts['apk:check'], /scripts\/check-android-build\.mjs/);
    assert.match(pkg.scripts['prepush:check'], /npm run validate/);
    assert.match(pkg.scripts['prepush:check'], /scripts\/check-android-build\.mjs --pre-push/);
    assert.match(scriptSource, /:app:checkReleaseAarMetadata/);
    assert.match(scriptSource, /:app:compileReleaseJavaWithJavac/);
  });

  it('detects Android-related file changes accurately', () => {
    assert.equal(
      hasAndroidChanges(['android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java']),
      true,
    );
    assert.equal(hasAndroidChanges(['capacitor.config.json']), true);
    assert.equal(hasAndroidChanges(['src/App.tsx', 'src/lib/storage.ts']), false);
  });

  it('parses sdk.dir from android/local.properties', () => {
    assert.equal(
      parseLocalPropertiesSdkDir('# comment\nsdk.dir=/home/dev/Android/Sdk\n'),
      '/home/dev/Android/Sdk',
    );
    assert.equal(
      parseLocalPropertiesSdkDir('sdk.dir=C\\:\\\\Users\\\\dev\\\\AppData\\\\Local\\\\Android\\\\Sdk'),
      'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk',
    );
  });

  it('detects ANDROID_HOME / ANDROID_SDK_ROOT / local.properties SDK paths', () => {
    assert.equal(
      detectAndroidSdkDir({
        env: { ANDROID_HOME: '/sdk/env' },
        exists: (p: string) => p === '/sdk/env',
      }),
      '/sdk/env',
    );
    assert.equal(
      detectAndroidSdkDir({
        env: {},
        androidDir: '/repo/android',
        homeDir: '/home/tester',
        platform: 'linux',
        exists: (p: string) => p === '/repo/android/local.properties' || p === '/sdk/local',
        readFile: () => 'sdk.dir=/sdk/local\n',
      }),
      '/sdk/local',
    );
  });

  it('selects the right gradle wrapper per platform', () => {
    assert.equal(getGradleWrapperCommand('linux'), './gradlew');
    assert.equal(getGradleWrapperCommand('darwin'), './gradlew');
    assert.equal(getGradleWrapperCommand('win32'), 'gradlew.bat');
  });

  it('blocks push when android/ changed and local JDK/Android SDK are unavailable', () => {
    const blocked = decideAndroidCheckAction({
      isPrePush: true,
      skipFlag: false,
      javaAvailable: false,
      androidSdkDir: '',
      androidChanged: true,
    });
    assert.equal(blocked.action, 'fail');

    const runsWhenReady = decideAndroidCheckAction({
      isPrePush: true,
      skipFlag: false,
      javaAvailable: true,
      androidSdkDir: '/opt/android-sdk',
      androidChanged: false,
    });
    assert.equal(runsWhenReady.action, 'run');

    const skipsWebOnlyWithoutSdk = decideAndroidCheckAction({
      isPrePush: true,
      skipFlag: false,
      javaAvailable: false,
      androidSdkDir: '',
      androidChanged: false,
    });
    assert.equal(skipsWebOnlyWithoutSdk.action, 'skip');

    const failsDirectCheckWithoutSdk = decideAndroidCheckAction({
      isPrePush: false,
      skipFlag: false,
      javaAvailable: false,
      androidSdkDir: '',
      androidChanged: false,
    });
    assert.equal(failsDirectCheckWithoutSdk.action, 'fail');

    const respectsExplicitOverride = decideAndroidCheckAction({
      isPrePush: true,
      skipFlag: true,
      javaAvailable: false,
      androidSdkDir: '',
      androidChanged: true,
    });
    assert.equal(respectsExplicitOverride.action, 'skip');
  });
  it('blocks AI Studio chat attachments from git and from Vite/APK builds', () => {
    const gitignore = readRepoFile('.gitignore');
    assert.match(gitignore, /^public\/assets\/aistudio\/$/m);

    const viteConfig = readRepoFile('vite.config.ts');
    assert.match(viteConfig, /exclude-aistudio-attachments/);
    assert.match(viteConfig, /globIgnores:[\s\S]*aistudio/);

    const tracked = execFileSync('git', ['ls-files', 'public/assets/aistudio'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    assert.equal(
      tracked,
      '',
      `public/assets/aistudio/ must never have tracked files in git: ${tracked}`,
    );
  });
});

describe('Video buffered progress bar (Android LibVLC + Web)', () => {
  it('defines secondaryProgress layer in Android seekbar_player_progress.xml', () => {
    const seekbarXml = readRepoFile(
      'android/app/src/main/res/drawable/seekbar_player_progress.xml',
    );
    const bgIdx = seekbarXml.indexOf('@android:id/background');
    const secIdx = seekbarXml.indexOf('@android:id/secondaryProgress');
    const progIdx = seekbarXml.indexOf('@android:id/progress');
    assert.ok(bgIdx >= 0, 'background layer must exist');
    assert.ok(secIdx > bgIdx, 'secondaryProgress layer must come after background');
    assert.ok(progIdx > secIdx, 'progress layer must render above secondaryProgress');
  });

  it('wires LocalProxyPlugin buffer telemetry and VlcPlayerActivity secondaryProgress updates', () => {
    const proxyJava = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/LocalProxyPlugin.java',
    );
    const activityJava = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java',
    );
    assert.match(proxyJava, /public interface BufferProgressListener/);
    assert.match(
      proxyJava,
      /public static String buildSharedProxyUrl\(String targetUrl, String referer, long sessionId\)/,
    );
    assert.match(proxyJava, /EXTINF_DURATION_PATTERN/);
    assert.match(proxyJava, /seg_start_ms/);
    assert.match(proxyJava, /seg_end_ms/);
    assert.match(proxyJava, /parseByteRangeWindow/);

    assert.match(activityJava, /--prefetch-buffer-size=32768/);
    assert.match(activityJava, /seekBar\.setSecondaryProgress\(/);
    assert.match(activityJava, /LocalProxyPlugin\.setBufferProgressListener\(/);
    assert.match(activityJava, /LocalProxyPlugin\.clearBufferProgressListener\(/);
    assert.match(activityJava, /applyByteRangeBufferSample/);
    assert.match(activityJava, /applyHlsTimeBufferSample/);
  });

  it('resolves the active buffered end timestamp for web video TimeRanges', () => {
    const makeRanges = (ranges: Array<[number, number]>) => ({
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    });

    assert.equal(resolveBufferedEndSec(makeRanges([]), 0, 1420), 0);
    assert.equal(resolveBufferedEndSec(makeRanges([[0, 125.5]]), 0, 1420), 125.5);
    assert.equal(
      resolveBufferedEndSec(
        makeRanges([
          [0, 60],
          [300, 420],
        ]),
        310,
        1420,
      ),
      420,
    );
    assert.equal(
      resolveBufferedEndSec(
        makeRanges([
          [0, 60],
          [300, 420],
        ]),
        15,
        1420,
      ),
      60,
    );
    assert.equal(resolveBufferedEndSec(makeRanges([[0, 2000]]), 500, 1420), 1420);
  });
});

describe('Android double-tap seek-only HUD guard', () => {
  it('declares vlc_bottom_controls_row inside vlc_bottom_bar and wires seek-only HUD in VlcPlayerActivity', () => {
    const layoutXml = readRepoFile('android/app/src/main/res/layout/activity_vlc_player.xml');
    const activityJava = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java',
    );

    assert.match(layoutXml, /android:id="@\+id\/vlc_top_bar"/);
    assert.match(layoutXml, /android:id="@\+id\/vlc_bottom_bar"/);
    assert.match(layoutXml, /android:id="@\+id\/vlc_seekbar"/);
    assert.match(layoutXml, /android:id="@\+id\/vlc_bottom_controls_row"/);
    assert.match(layoutXml, /android:id="@\+id\/vlc_seek_badge"/);

    assert.match(activityJava, /topBar\s*=\s*findViewById\(R\.id\.vlc_top_bar\)/);
    assert.match(activityJava, /bottomBar\s*=\s*findViewById\(R\.id\.vlc_bottom_bar\)/);
    assert.match(
      activityJava,
      /bottomControlsRow\s*=\s*findViewById\(R\.id\.vlc_bottom_controls_row\)/,
    );
    assert.match(activityJava, /private\s+void\s+showSeekOnlyHud\(\)/);
    assert.match(activityJava, /private\s+void\s+applyHudVisibility\(\)/);
    assert.match(activityJava, /hideSeekOnlyHudRunnable/);
    assert.match(activityJava, /seekByMs\(side < 0 \? -5000L : 5000L, badgeLabel, false, true\)/);
    assert.match(activityJava, /uiHandler\.postDelayed\(singleTapRunnable, DOUBLE_TAP_WINDOW_MS\)/);
  });
});

describe('Android LibVLC audio stability & TheTVDB UI layout guards', () => {
  it('avoids frame-drop suppression and guards Event.Playing, audio focus, fast seeks, and aout selection in VlcPlayerActivity', () => {
    const activityJava = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java',
    );

    assert.doesNotMatch(
      activityJava,
      /--no-drop-late-frames/,
      'LibVLC must not disable drop-late-frames (causes multi-second audio desync on seek and resume)',
    );
    assert.doesNotMatch(
      activityJava,
      /--no-skip-frames/,
      'LibVLC must not disable skip-frames (causes multi-second audio desync on seek and resume)',
    );
    assert.match(activityJava, /--audio-time-stretch/);
    assert.match(activityJava, /--aout=/);
    assert.match(activityJava, /HWDecoderUtil\.getAudioOutputFromDevice\(\)/);
    assert.match(activityJava, /mediaPlayer\.setAudioOutput\(resolvedAout\)/);
    assert.match(activityJava, /"opensles"/);
    assert.match(activityJava, /"android_audiotrack"/);
    assert.match(activityJava, /private boolean hasAudioFocus = false/);
    assert.match(activityJava, /AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK/);
    assert.match(activityJava, /commitInteractiveSeekRunnable/);
    assert.match(
      activityJava,
      /mediaPlayer\.setTime\(target, false\)/,
      'LibVLC seeks must use exact mode (fast=false) so +5s forward seeks never snap backward to a previous keyframe',
    );
    assert.doesNotMatch(
      activityJava,
      /mediaPlayer\.setTime\(target, true\)/,
      'fast=true snaps short forward seeks backward on 5-10s GOP anime encodes',
    );
    assert.match(activityJava, /hasActiveSeekArrived\(/);
    assert.match(activityJava, /activeSeekOriginMs/);
    assert.match(activityJava, /syncPlayerPlaybackParametersIfNeeded\(\)/);
    assert.match(activityJava, /mediaPlayer\.getRate\(\)/);
    assert.match(activityJava, /mediaPlayer\.getVolume\(\)/);
    assert.match(activityJava, /mediaPlayer\.getAudioTrack\(\)/);
  });

  it('places episode synopsis and "Ver todos os episódios" button above "Marcar como visto" and "Favoritar" in EpisodeWorkspace', () => {
    const workspaceTsx = readRepoFile('src/components/EpisodeWorkspace.tsx');

    const synopsisIdx = workspaceTsx.indexOf('data-episode-synopsis="true"');
    const allEpisodesBtnIdx = workspaceTsx.indexOf("'Ver todos os episódios'");
    const watchedBtnIdx = workspaceTsx.indexOf("'Marcar como visto'");
    const favoriteBtnIdx = workspaceTsx.indexOf("'Favoritar'");

    assert.ok(synopsisIdx > 0, 'EpisodeWorkspace must render data-episode-synopsis');
    assert.ok(allEpisodesBtnIdx > 0, 'EpisodeWorkspace must render "Ver todos os episódios"');
    assert.ok(watchedBtnIdx > 0, 'EpisodeWorkspace must render "Marcar como visto"');
    assert.ok(favoriteBtnIdx > 0, 'EpisodeWorkspace must render "Favoritar"');
    assert.ok(
      synopsisIdx < watchedBtnIdx && synopsisIdx < favoriteBtnIdx,
      'Episode synopsis must appear above "Marcar como visto" and "Favoritar"',
    );
    assert.ok(
      allEpisodesBtnIdx < watchedBtnIdx && allEpisodesBtnIdx < favoriteBtnIdx,
      '"Ver todos os episódios" button must appear above "Marcar como visto" and "Favoritar"',
    );
    assert.match(workspaceTsx, /tvdbSynopsis\?\.episodeImage/);
    assert.match(workspaceTsx, /matchedSeriesEpisode\?\.thumb/);
  });

  it('loads localized TheTVDB anime synopsis and shows TheTVDB episode thumbnails across mobile and desktop in AnimeDetailView', () => {
    const detailTsx = readRepoFile('src/components/AnimeDetailView.tsx');

    assert.match(detailTsx, /\/api\/anime-synopsis\?/);
    assert.match(detailTsx, /data-anime-synopsis="true"/);
    assert.match(detailTsx, /TheTVDB · Traduzido via Google Tradutor/);
    assert.match(detailTsx, /effectivePoster = tvdbAnimeSynopsis\?\.poster \|\| anime\.poster/);
    assert.doesNotMatch(
      detailTsx,
      /hidden h-12 w-20 shrink-0 rounded-md border border-white\/10 sm:block/,
      'Episode thumbnails in AnimeDetailView should remain visible on mobile screens too',
    );
    assert.match(detailTsx, /data-season-tabs="true"/);
    assert.match(detailTsx, /data-season-toggle=/);
    assert.match(detailTsx, /data-toggle-all-seasons="true"/);
    assert.match(detailTsx, /Expandir tudo/);
    assert.match(detailTsx, /Recolher tudo/);

    const appTsx = readRepoFile('src/App.tsx');
    assert.match(appTsx, /resolveSeriesEpisodesForEpisode\(/);
  });

  it('omits redundant top Avisos/Favoritos buttons in AnimeDetailView and avoids duplicate bottom toast for unavailable upcoming episodes', () => {
    const detailTsx = readRepoFile('src/components/AnimeDetailView.tsx');
    const returnIdx = detailTsx.lastIndexOf('  return (\n    <div className="mx-auto max-w-7xl');
    const heroCardIdx = detailTsx.indexOf('{/* Hero Info Card enriched by TheTVDB */}');
    assert.ok(returnIdx > 0 && heroCardIdx > returnIdx, 'Top bar and Hero Info Card markers must exist in AnimeDetailView');
    const topBarSection = detailTsx.slice(returnIdx, heroCardIdx);
    assert.doesNotMatch(
      topBarSection,
      /Nos Favoritos|Favoritar/,
      'Top navigation bar above the hero card should not duplicate the Favoritar button',
    );
    assert.doesNotMatch(
      topBarSection,
      /onToggleMuteFavorite/,
      'Top navigation bar above the hero card should not duplicate the Avisos button',
    );

    // Action row inside hero card must still keep both buttons
    const heroSection = detailTsx.slice(heroCardIdx);
    assert.match(heroSection, /Nos Favoritos/);
    assert.match(heroSection, /Avisos ativos/);

    const playerTsx = readRepoFile('src/components/AnimePlayer.tsx');
    const workspaceTsx = readRepoFile('src/components/EpisodeWorkspace.tsx');
    assert.doesNotMatch(
      playerTsx,
      /onToast\(formatUpcomingEpisodeNotice/,
      'AnimePlayer must not show a redundant bottom toast alongside the in-player upcoming notice',
    );
    assert.doesNotMatch(
      workspaceTsx,
      /onToast\(formatUpcomingEpisodeNotice/,
      'EpisodeWorkspace top upcoming pill must not show a redundant bottom toast',
    );
    assert.match(workspaceTsx, /data-upcoming-next-pill="true"/);
    assert.match(playerTsx, /data-player-upcoming-banner="true"/);
  });

  it('keeps season card headers uniformly aligned with consistent badges, far-right chevron, and auto-exits fullscreen on end without next episode', () => {
    const detailTsx = readRepoFile('src/components/AnimeDetailView.tsx');
    assert.match(detailTsx, /data-season-header=/);
    assert.match(detailTsx, /data-season-badge=/);
    assert.match(detailTsx, /data-season-chevron=/);
    assert.match(detailTsx, /shrink-0 whitespace-nowrap text-xs font-semibold uppercase/);
    assert.doesNotMatch(
      detailTsx,
      /\$\{fullGroup\.episodes\.length\} eps/,
      'Unavailable seasons should use the same 0/N orange badge style instead of a gray "N eps" badge',
    );
    assert.doesNotMatch(
      detailTsx,
      /border-white\/15 bg-white\/8 text-slate-300/,
      'Season counter badges should stay consistent across seasons',
    );
    assert.match(
      detailTsx,
      /data-season-mark-desktop=\{group\.seasonNumber\}[\s\S]{0,600}hidden sm:inline-flex/,
      'Header mark-season button must always stay hidden on mobile so it never overlaps the episode badge',
    );
    assert.doesNotMatch(
      detailTsx,
      /canCollapseSeason \? 'hidden sm:inline-flex' : 'inline-flex'/,
      'Non-collapsible single-season tabs must not force the mark-season button inline into the narrow mobile header',
    );
    assert.match(detailTsx, /data-season-mobile-actions=\{group\.seasonNumber\}/);

    const playerTsx = readRepoFile('src/components/AnimePlayer.tsx');
    assert.match(playerTsx, /const exitFullscreenIfActive = useCallback/);
    assert.match(playerTsx, /else if \(reachedGenuineEnd && !hasNext\) \{\s*exitFullscreenIfActive\(\);/);

    const vlcJava = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java',
    );
    assert.match(
      vlcJava,
      /if \(!hasNextAvailable\) \{\s*updateMediaSessionPlaybackState\(PlaybackState\.STATE_STOPPED\);\s*finishWithAction\("closed", false\);\s*return;\s*\}/,
    );

    const calendarTsx = readRepoFile('src/components/LiveChartCalendar.tsx');
    assert.match(calendarTsx, /data-calendar-card-footer="true"/);
    assert.match(calendarTsx, /data-calendar-badges-compact="true"/);
    assert.match(calendarTsx, /data-calendar-meta-row="true"/);
    assert.match(calendarTsx, /data-calendar-service-row="true"/);
    assert.match(calendarTsx, /data-calendar-episode-tag="true"/);
    assert.match(calendarTsx, /data-calendar-service-name="true"/);
    assert.match(calendarTsx, /renderReleaseBadges\(item, true\)/);
    assert.match(playerTsx, /onClick=\{\(\) => setMenuTab\('quality'\)\}\s*className="[^"]*sm:hidden"/);
    assert.match(playerTsx, /onClick=\{\(\) => setMenuTab\('subs'\)\}\s*className="[^"]*sm:hidden"/);
  });

  it('prevents long-press haptic vibration and drag/contextmenu callouts on cards while preserving editable inputs', () => {
    const mainActivity = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/MainActivity.java',
    );
    assert.match(mainActivity, /webView\.setHapticFeedbackEnabled\(false\);/);
    assert.match(mainActivity, /webView\.setLongClickable\(false\);/);
    assert.match(mainActivity, /WebView\.HitTestResult\.EDIT_TEXT_TYPE/);

    const indexCss = readRepoFile('src/index.css');
    assert.match(indexCss, /user-select:\s*none;/);
    assert.match(indexCss, /-webkit-touch-callout:\s*none;/);
    assert.match(indexCss, /input,\s*textarea,/);
    assert.match(indexCss, /user-select:\s*text;/);

    const mediaPoster = readRepoFile('src/components/MediaPoster.tsx');
    assert.match(mediaPoster, /draggable=\{false\}/);

    const mainTsx = readRepoFile('src/main.tsx');
    assert.match(mainTsx, /addEventListener\('contextmenu'/);
    assert.match(mainTsx, /addEventListener\('dragstart'/);
    assert.match(mainTsx, /isEditableTouchTarget/);
  });

  it('does not add episodes to watch history on page open before actual video playback starts', () => {
    const appTsx = readRepoFile('src/App.tsx');
    const loadEpStart = appTsx.indexOf('const loadEpisodeDetailsForRoute = useCallback(');
    const syncNativeStart = appTsx.indexOf('const syncNativeSessionResult = useCallback(');
    assert.ok(
      loadEpStart > 0 && syncNativeStart > loadEpStart,
      'loadEpisodeDetailsForRoute and syncNativeSessionResult markers must exist in App.tsx',
    );
    const loadEpBody = appTsx.slice(loadEpStart, syncNativeStart);
    assert.doesNotMatch(
      loadEpBody,
      /pushHistoryEntry\(/,
      'Opening an episode page must not push it into watch history before the user presses play',
    );

    const playerTsx = readRepoFile('src/components/AnimePlayer.tsx');
    assert.match(playerTsx, /const recordHistoryOnPlaybackStart = useCallback/);
    assert.match(
      playerTsx,
      /if \(!opts\?\.forceReset && !ended && !latestPlaybackRef\.current\.hasStarted\) \{/,
      'Unplayed episode unmounts must not persist progress or history',
    );
    assert.match(playerTsx, /recordHistoryOnPlaybackStart\(episodeUrl\);/);
  });

  it('renders Dublado/Legendado audio track tabs in AnimeDetailView and scopes playback lists per audio track', () => {
    const detailTsx = readRepoFile('src/components/AnimeDetailView.tsx');
    assert.match(detailTsx, /data-audio-track-tabs="true"/);
    assert.match(detailTsx, /data-audio-track-tab=\{audioKey\}/);
    assert.match(detailTsx, /data-hero-audio-badge=\{effectiveAudioType\}/);
    assert.match(detailTsx, /Sem dublagem/);
    assert.match(detailTsx, /primaryLatestEpisode/);

    const appTsx = readRepoFile('src/App.tsx');
    assert.match(appTsx, /resolveSeriesEpisodesForEpisode\(\s*animeDetails,/);
    assert.match(appTsx, /currentAnime\.audioTracks\?\.DUB\?\.episodes/);
    assert.match(appTsx, /currentAnime\.audioTracks\?\.LEG\?\.episodes/);

    const workspaceTsx = readRepoFile('src/components/EpisodeWorkspace.tsx');
    assert.match(workspaceTsx, /resolveSeriesEpisodesForEpisode\(/);
  });
});
