import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT_DIR, 'android');

const ANDROID_RELATED_PATTERNS = [/^android\//, /^capacitor\.config\.(json|ts|js)$/];

export function hasAndroidChanges(changedFiles) {
  return changedFiles.some((filePath) => {
    const normalized = String(filePath || '')
      .trim()
      .replace(/\\/g, '/');
    return ANDROID_RELATED_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

export function parseLocalPropertiesSdkDir(content) {
  if (!content) return '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^sdk\.dir\s*=\s*(.+)$/);
    if (!match) continue;
    return match[1]
      .trim()
      .replace(/\\:/g, ':')
      .replace(/\\\\/g, '\\');
  }
  return '';
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   androidDir?: string;
 *   homeDir?: string;
 *   platform?: string;
 *   exists?: (targetPath: string) => boolean;
 *   readFile?: (targetPath: string) => string;
 * }} [options]
 */
export function detectAndroidSdkDir({
  env = process.env,
  androidDir = ANDROID_DIR,
  homeDir = os.homedir(),
  platform = process.platform,
  exists = (targetPath) => existsSync(targetPath),
  readFile = (targetPath) => readFileSync(targetPath, "utf8"),
} = {}) {
  const envCandidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(Boolean);
  for (const candidate of envCandidates) {
    if (exists(candidate)) return candidate;
  }

  const localPropertiesPath = path.join(androidDir, 'local.properties');
  if (exists(localPropertiesPath)) {
    try {
      const sdkDir = parseLocalPropertiesSdkDir(readFile(localPropertiesPath));
      if (sdkDir && exists(sdkDir)) return sdkDir;
    } catch {
      // Ignore unreadable local.properties
    }
  }

  const defaultCandidates =
    platform === 'win32'
      ? [
          env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : '',
          path.join(homeDir, 'AppData', 'Local', 'Android', 'Sdk'),
        ]
      : platform === 'darwin'
        ? [path.join(homeDir, 'Library', 'Android', 'sdk'), path.join(homeDir, 'Android', 'Sdk')]
        : [
            path.join(homeDir, 'Android', 'Sdk'),
            '/usr/local/lib/android/sdk',
            '/opt/android-sdk',
          ];

  for (const candidate of defaultCandidates) {
    if (candidate && exists(candidate)) return candidate;
  }

  return '';
}

export function getGradleWrapperCommand(platform = process.platform) {
  return platform === 'win32' ? 'gradlew.bat' : './gradlew';
}

export function decideAndroidCheckAction({
  isPrePush,
  skipFlag,
  javaAvailable,
  androidSdkDir,
  androidChanged,
}) {
  if (skipFlag) {
    return {
      action: 'skip',
      reason: 'SKIP_ANDROID_BUILD_CHECK=1 definido — pulando compilação Gradle local.',
    };
  }

  if (javaAvailable && androidSdkDir) {
    return {
      action: 'run',
      reason: 'JDK e Android SDK disponíveis — executando sync Capacitor e compilação Gradle.',
    };
  }

  const missingParts = [];
  if (!javaAvailable) missingParts.push('Java (JDK 21+)');
  if (!androidSdkDir) missingParts.push('Android SDK (ANDROID_HOME)');
  const missingText = missingParts.join(' e ');

  if (!isPrePush) {
    return {
      action: 'fail',
      reason: `Não foi possível validar o build Android localmente: ${missingText} não encontrado(s).`,
    };
  }

  if (androidChanged) {
    return {
      action: 'fail',
      reason:
        `Arquivos em android/ foram modificados, mas ${missingText} não está(ão) configurado(s) localmente para testar o build antes do push. ` +
        'Configure JAVA_HOME e ANDROID_HOME (ou use SKIP_ANDROID_BUILD_CHECK=1 git push se quiser validar apenas no GitHub Actions).',
    };
  }

  return {
    action: 'skip',
    reason: `Nenhuma alteração em android/ detectada e ${missingText} indisponível localmente — build Web e testes estáticos passaram.`,
  };
}

function isJavaAvailable() {
  const res = spawnSync('java', ['-version'], { stdio: 'ignore' });
  return res.status === 0;
}

function getChangedFilesForPrePush() {
  const files = new Set();

  const tryGitDiff = (args) => {
    try {
      const out = execFileSync('git', args, {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
      return true;
    } catch {
      return false;
    }
  };

  // Detect outgoing commits relative to upstream branch, falling back to origin/main, origin/dev, or HEAD~1.
  const baseCandidates = ['@{u}', 'origin/main', 'origin/dev', 'HEAD~1'];
  for (const base of baseCandidates) {
    if (tryGitDiff(['diff', '--name-only', `${base}...HEAD`])) {
      break;
    }
  }

  // Also include staged/unstaged local edits so manual checks see them.
  tryGitDiff(['diff', '--name-only', 'HEAD']);
  tryGitDiff(['diff', '--cached', '--name-only']);

  return [...files];
}

function runCommandOrExit(command, args, { cwd, env }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`❌ Falha ao executar "${command} ${args.join(' ')}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const isPrePush = args.has('--pre-push');
  const skipFlag = process.env.SKIP_ANDROID_BUILD_CHECK === '1';

  const javaAvailable = isJavaAvailable();
  const androidSdkDir = detectAndroidSdkDir();
  const changedFiles = isPrePush ? getChangedFilesForPrePush() : [];
  const androidChanged = isPrePush ? hasAndroidChanges(changedFiles) : true;

  const decision = decideAndroidCheckAction({
    isPrePush,
    skipFlag,
    javaAvailable,
    androidSdkDir,
    androidChanged,
  });

  if (decision.action === 'skip') {
    console.log(`ℹ️ ${decision.reason}`);
    process.exit(0);
  }

  if (decision.action === 'fail') {
    console.error(`❌ ${decision.reason}`);
    process.exit(1);
  }

  console.log(`🤖 ${decision.reason}`);

  const childEnv = {
    ...process.env,
    ANDROID_HOME: process.env.ANDROID_HOME || androidSdkDir,
    ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || androidSdkDir,
  };

  console.log('📦 Sincronizando bundle Web com Capacitor Android (npx cap sync android)...');
  runCommandOrExit('npx', ['cap', 'sync', 'android'], { cwd: ROOT_DIR, env: childEnv });

  const gradlew = getGradleWrapperCommand();
  console.log(
    `🔨 Validando compilação Android Release (${gradlew} :app:checkReleaseAarMetadata :app:compileReleaseJavaWithJavac :app:testDebugUnitTest --no-daemon)...`,
  );
  runCommandOrExit(
    gradlew,
    [
      ':app:checkReleaseAarMetadata',
      ':app:compileReleaseJavaWithJavac',
      ':app:testDebugUnitTest',
      '--no-daemon',
    ],
    { cwd: ANDROID_DIR, env: childEnv },
  );

  console.log(
    '✅ Build Android (checkReleaseAarMetadata + compileReleaseJavaWithJavac + unit tests) passou!',
  );
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
  main();
}
