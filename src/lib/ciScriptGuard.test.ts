import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

function listFilesRecursive(dir: string, ext: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function assertBalancedJavaDelimiters(filePath: string, source: string): void {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let inStr = false;
  let inChar = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (inChar) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === "'") inChar = false;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "'") {
      inChar = true;
      continue;
    }
    if (c === '{') braces += 1;
    else if (c === '}') braces -= 1;
    else if (c === '(') parens += 1;
    else if (c === ')') parens -= 1;
    else if (c === '[') brackets += 1;
    else if (c === ']') brackets -= 1;

    assert.ok(
      braces >= 0 && parens >= 0 && brackets >= 0,
      `Negative delimiter balance in ${filePath} at offset ${i}`
    );
  }

  assert.equal(braces, 0, `Unbalanced {} in ${filePath}`);
  assert.equal(parens, 0, `Unbalanced () in ${filePath}`);
  assert.equal(brackets, 0, `Unbalanced [] in ${filePath}`);
  assert.equal(inStr, false, `Unterminated string literal in ${filePath}`);
  assert.equal(inChar, false, `Unterminated char literal in ${filePath}`);
  assert.equal(inBlockComment, false, `Unterminated block comment in ${filePath}`);
}

describe('Pre-push CI workflow, shell script, OpenSSL, and Java static guards', () => {
  it('validates all .github/workflows/*.yml YAML syntax, job needs, outputs, and referenced scripts', () => {
    const wfDir = resolve(ROOT, '.github/workflows');
    const wfFiles = readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    assert.ok(wfFiles.length > 0, 'Expected at least one GitHub Actions workflow');

    for (const wfName of wfFiles) {
      const raw = readFileSync(join(wfDir, wfName), 'utf8');
      const parsed = YAML.parse(raw) as {
        name?: string;
        jobs?: Record<
          string,
          {
            uses?: string;
            needs?: string | string[];
            outputs?: Record<string, string>;
            steps?: Array<{ run?: string }>;
          }
        >;
      };

      assert.ok(parsed && typeof parsed === 'object', `${wfName} must parse as YAML object`);
      assert.ok(parsed.jobs && typeof parsed.jobs === 'object', `${wfName} must declare jobs`);

      const jobs = parsed.jobs;
      const jobIds = new Set(Object.keys(jobs));
      for (const [jobId, job] of Object.entries(jobs)) {
        if (typeof job.uses === 'string' && job.uses.startsWith('./')) {
          assert.ok(
            existsSync(resolve(ROOT, job.uses.slice(2))),
            `${wfName}: job "${jobId}" references missing local reusable workflow "${job.uses}"`
          );
        }

        const needsList = Array.isArray(job.needs)
          ? job.needs
          : typeof job.needs === 'string'
            ? [job.needs]
            : [];
        for (const dep of needsList) {
          assert.ok(
            jobIds.has(dep),
            `${wfName}: job "${jobId}" references unknown needs job "${dep}"`
          );
        }

        for (const step of job.steps || []) {
          if (typeof step.run !== 'string') continue;
          for (const match of step.run.matchAll(/\bscripts\/([A-Za-z0-9._-]+\.(?:sh|mjs|js))\b/g)) {
            const scriptRel = `scripts/${match[1]}`;
            assert.ok(
              existsSync(resolve(ROOT, scriptRel)),
              `${wfName}: step in job "${jobId}" references missing script "${scriptRel}"`
            );
          }
        }
      }

      // Verify every ${{ needs.<job>.outputs.<key> }} reference matches a declared output
      for (const match of raw.matchAll(/needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
        const refJob = match[1];
        const refOut = match[2];
        const declared: Record<string, string> | undefined = jobs[refJob]?.outputs;
        assert.ok(
          declared && Object.prototype.hasOwnProperty.call(declared, refOut),
          `${wfName}: references needs.${refJob}.outputs.${refOut} which is not declared in ${refJob}.outputs`
        );
      }
    }
  });

  it('validates all scripts/*.sh line endings, bash syntax, and OpenSSL 3.0.x compatibility flags', () => {
    const scriptsDir = resolve(ROOT, 'scripts');
    const shFiles = readdirSync(scriptsDir).filter((f) => f.endsWith('.sh'));
    assert.ok(shFiles.length > 0, 'Expected shell build scripts under scripts/');

    const bashCandidates =
      process.platform === 'win32'
        ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash']
        : ['bash'];
    const bashBin = bashCandidates.find((bin) => {
      const check = spawnSync(bin, ['--version'], { stdio: 'ignore' });
      return check.status === 0;
    });

    for (const file of shFiles) {
      const fullPath = join(scriptsDir, file);
      const raw = readFileSync(fullPath, 'utf8');
      assert.ok(!raw.includes('\r'), `scripts/${file} must use pure LF endings (no CRLF)`);
      assert.match(raw, /^#!\/usr\/bin\/env bash\n/, `scripts/${file} must start with bash shebang`);
      assert.match(raw, /set -euo pipefail/, `scripts/${file} must enable set -euo pipefail`);

      if (bashBin) {
        const res = spawnSync(bashBin, ['-n', fullPath], { encoding: 'utf8' });
        assert.equal(
          res.status,
          0,
          `bash -n syntax check failed for scripts/${file}: ${res.stderr || res.stdout}`
        );
      }
    }

    const nodeScripts = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
    for (const file of nodeScripts) {
      const fullPath = join(scriptsDir, file);
      const res = spawnSync(process.execPath, ['--check', fullPath], { encoding: 'utf8' });
      assert.equal(
        res.status,
        0,
        `node --check syntax check failed for scripts/${file}: ${res.stderr || res.stdout}`
      );
    }

    // OpenSSL 3.0.x compatibility guard (catches unsupported 3.2+ flags like `no-docs` before CI!)
    const aria2Script = readRepoFile('scripts/build-aria2-android.sh');
    const osslMatch = aria2Script.match(/OPENSSL_VERSION:-(\d+\.\d+\.\d+)/);
    assert.ok(osslMatch, 'scripts/build-aria2-android.sh must declare OPENSSL_VERSION');
    if (osslMatch[1].startsWith('3.0.')) {
      for (const unsupportedFlag of ['no-docs', 'no-quic', 'no-http', 'no-argon2']) {
        assert.doesNotMatch(
          aria2Script,
          new RegExp(`(^|\\s)${unsupportedFlag}(\\s|\\\\|$)`),
          `OpenSSL ${osslMatch[1]} does not support Configure flag "${unsupportedFlag}"`
        );
      }
    }
    assert.match(aria2Script, /--with-openssl/);
    assert.match(aria2Script, /--with-libz/);
    assert.match(aria2Script, /--without-libcares/);
    assert.match(aria2Script, /max-page-size=16384/);
  });

  it('audits every Android Java source file for balanced delimiters, unique @PluginMethod names, and safe Capacitor params', () => {
    const javaRoot = resolve(ROOT, 'android/app/src/main/java');
    const javaFiles = listFilesRecursive(javaRoot, '.java');
    assert.ok(javaFiles.length >= 10, 'Expected Android Java sources');

    for (const fullPath of javaFiles) {
      const src = readFileSync(fullPath, 'utf8');
      assertBalancedJavaDelimiters(fullPath, src);

      const pluginMethods = [...src.matchAll(/@PluginMethod\s+public\s+void\s+(\w+)\s*\(/g)].map(
        (m) => m[1]
      );
      const unique = new Set(pluginMethods);
      assert.equal(
        unique.size,
        pluginMethods.length,
        `Duplicate @PluginMethod declarations in ${fullPath}: ${pluginMethods.join(', ')}`
      );

      assert.doesNotMatch(
        src,
        /\bcall\.getLong\(/,
        `Forbidden Capacitor PluginCall.getLong() in ${fullPath} — read numeric params via call.getData().opt(...)`
      );
    }
  });
});
