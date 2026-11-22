import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
  it('blocks committing unused AI Studio chat attachments in public/assets/aistudio', () => {
    const gitignore = readRepoFile('.gitignore');
    assert.match(gitignore, /^public\/assets\/aistudio\/\*$/m);

    const aistudioDir = resolve(ROOT, 'public/assets/aistudio');
    const files = readdirSync(aistudioDir);
    const disallowed = files.filter((f) => !/^captura-topanimes\.net-[\w-]+\.html$/.test(f));
    assert.deepEqual(
      disallowed,
      [],
      `Unexpected non-fixture files in public/assets/aistudio/: ${disallowed.join(', ')}`,
    );
  });
});
