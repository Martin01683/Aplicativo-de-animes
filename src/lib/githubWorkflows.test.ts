import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(__dirname, '../../.github/workflows');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  uses?: string;
  if?: string;
  needs?: string | string[];
  with?: Record<string, unknown>;
  secrets?: string | Record<string, string>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(fileName: string): Workflow {
  const raw = readFileSync(resolve(WORKFLOWS_DIR, fileName), 'utf-8');
  return parse(raw) as Workflow;
}

function loadWorkflowRaw(fileName: string): string {
  return readFileSync(resolve(WORKFLOWS_DIR, fileName), 'utf-8');
}

describe('.github/workflows/build.yml - build & publish orchestration', () => {
  const workflow = loadWorkflow('build.yml');

  it('is only triggered manually (workflow_dispatch)', () => {
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  });

  it('grants write access to contents at the workflow level', () => {
    assert.deepEqual(workflow.permissions, { contents: 'write' });
  });

  it('has a single job delegating to the reusable CI workflow', () => {
    const jobs = Object.values(workflow.jobs);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].uses, './.github/workflows/test.yml');
    assert.deepEqual(jobs[0].with, { publish: true });
    assert.deepEqual(jobs[0].permissions, { contents: 'write' });
  });

  // Reusable workflows do not receive the caller's secrets automatically. Without this the
  // release signing key never reaches test.yml and the APK cannot be signed.
  it('passes the repository secrets (signing key) to the reusable workflow', () => {
    const [job] = Object.values(workflow.jobs);
    assert.equal(job.secrets, 'inherit');
  });

  it('does not duplicate Gradle or artifact download steps', () => {
    const raw = loadWorkflowRaw('build.yml');
    assert.doesNotMatch(raw, /download-artifact/);
    assert.doesNotMatch(raw, /gradlew/);
  });
});

describe('.github/workflows/test.yml - CI, secret scan, and Android APK build', () => {
  const workflow = loadWorkflow('test.yml');
  const validateJob = workflow.jobs['validate-and-test'];
  const buildApkJob = workflow.jobs['build-apk'];
  const publishJob = workflow.jobs['publish-release'];

  it('triggers on push/pull_request for main and dev, plus workflow_dispatch and workflow_call', () => {
    const on = workflow.on as {
      push: { branches: string[] };
      pull_request: { branches: string[] };
      workflow_call: { inputs: { publish: { type: string; default: boolean } } };
    };
    assert.deepEqual(on.push.branches, ['main', 'dev']);
    assert.deepEqual(on.pull_request.branches, ['main', 'dev']);
    assert.equal(on.workflow_call.inputs.publish.type, 'boolean');
    assert.equal(on.workflow_call.inputs.publish.default, false);
  });

  it('runs gitleaks with full git history before typecheck, lint, tests, and build', () => {
    const steps = validateJob.steps ?? [];
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout'));
    assert.ok(checkout);

    const names = steps.map((s) => s.name ?? '');
    const gitleaksIdx = names.indexOf('Scan for leaked secrets (gitleaks)');
    const typecheckIdx = names.indexOf('Check Types');
    const lintIdx = names.indexOf('Run Linter');
    const testIdx = names.indexOf('Run Unit Tests');
    const buildIdx = names.indexOf('Build Web Bundle');

    assert.ok(gitleaksIdx > -1);
    assert.ok(typecheckIdx > gitleaksIdx);
    assert.ok(lintIdx > typecheckIdx);
    assert.ok(testIdx > lintIdx);
    assert.ok(buildIdx > testIdx);
  });

  it('builds the Android APK only after validate-and-test passes', () => {
    assert.equal(buildApkJob.needs, 'validate-and-test');
    const stepNames = (buildApkJob.steps ?? []).map((s) => s.name ?? '');
    assert.ok(stepNames.includes('Build Release APK'));
    assert.ok(stepNames.includes('Upload APK artifact'));
  });

  it('publishes the APK release only when requested, after the APK build', () => {
    assert.ok(publishJob);
    assert.equal(publishJob.needs, 'build-apk');
    assert.match(publishJob.if ?? '', /inputs\.publish/);

    const stepNames = (publishJob.steps ?? []).map((s) => s.name ?? '');
    assert.ok(stepNames.includes('Download APK artifact'));
    assert.ok(stepNames.includes('Publish APK Release'));
  });

  // Regression: `gh release create` failed with a read-only GITHUB_TOKEN. The top-level
  // `contents: read` also applies inside a reusable workflow (a called workflow can only
  // restrict the caller's token, never elevate it), so the job that publishes the release
  // must ask for `contents: write` itself. No other job should have write access.
  it('grants contents: write only to the publish job', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(publishJob.permissions, { contents: 'write' });
    assert.equal(validateJob.permissions, undefined);
    assert.equal(buildApkJob.permissions, undefined);
  });

  // Regression: installing a new APK over the old one failed with "package already exists"
  // because the CI published the DEBUG build, which is signed with a debug keystore that is
  // regenerated on every fresh GitHub runner (so every APK had a different signature).
  describe('release APK signing', () => {
    const raw = loadWorkflowRaw('test.yml');
    const buildSteps = buildApkJob.steps ?? [];
    const SIGNING_SECRETS = [
      'ANDROID_KEYSTORE_BASE64',
      'ANDROID_KEYSTORE_PASSWORD',
      'ANDROID_KEY_ALIAS',
      'ANDROID_KEY_PASSWORD',
    ];

    it('builds the release variant and never the debug one', () => {
      assert.match(raw, /gradlew assembleRelease/);
      assert.doesNotMatch(raw, /assembleDebug/);
      assert.doesNotMatch(raw, /outputs\/apk\/debug/);
    });

    it('publishes the release APK (TopAnimes.apk), not the debug one', () => {
      const publish = (publishJob.steps ?? []).find((s) => s.name === 'Publish APK Release');
      assert.ok(publish?.run);
      assert.match(publish.run, /gh release (upload|create) .*TopAnimes\.apk/);
      assert.doesNotMatch(publish.run, /gh release (upload|create)[^\n]*TopAnimes-debug\.apk/);
    });

    it('removes the legacy debug APK from the existing release', () => {
      const publish = (publishJob.steps ?? []).find((s) => s.name === 'Publish APK Release');
      assert.match(publish?.run ?? '', /gh release delete-asset .*TopAnimes-debug\.apk/);
    });

    it('creates a new versioned release per build so previous versions stay available', () => {
      const publish = (publishJob.steps ?? []).find((s) => s.name === 'Publish APK Release');
      const script = publish?.run ?? '';
      assert.match(script, /v1\.0\.\$\{\{\s*github\.run_number\s*\}\}/);
      assert.match(script, /gh release create "\$TAG" TopAnimes\.apk/);
      assert.doesNotMatch(script, /gh release upload\b[^\n]*--clobber/);
    });

    it('requires all four signing secrets before building', () => {
      const prepare = buildSteps.find((s) => s.name === 'Prepare release signing key');
      assert.ok(prepare, 'missing "Prepare release signing key" step');
      for (const name of SIGNING_SECRETS) {
        assert.equal(prepare.env?.[name], `\${{ secrets.${name} }}`);
      }
      const names = buildSteps.map((s) => s.name ?? '');
      assert.ok(names.indexOf('Prepare release signing key') < names.indexOf('Build Release APK'));
    });

    it('passes the key passwords to Gradle through secrets, never as literals', () => {
      const build = buildSteps.find((s) => s.name === 'Build Release APK');
      assert.ok(build);
      assert.equal(build.env?.ANDROID_KEYSTORE_PASSWORD, '${{ secrets.ANDROID_KEYSTORE_PASSWORD }}');
      assert.equal(build.env?.ANDROID_KEY_ALIAS, '${{ secrets.ANDROID_KEY_ALIAS }}');
      assert.equal(build.env?.ANDROID_KEY_PASSWORD, '${{ secrets.ANDROID_KEY_PASSWORD }}');
    });

    it('keeps the signing secrets away from npm install and from job-wide env', () => {
      assert.equal(buildApkJob.env, undefined);
      const install = buildSteps.find((s) => s.name === 'Install npm dependencies');
      assert.ok(install);
      assert.equal(install.env, undefined);
    });

    it('verifies the APK is signed and not debuggable before uploading it', () => {
      const names = buildSteps.map((s) => s.name ?? '');
      const verifyIdx = names.indexOf('Verify release APK (signed, not debuggable)');
      assert.ok(verifyIdx > names.indexOf('Build Release APK'));
      assert.ok(verifyIdx < names.indexOf('Upload APK artifact'));
      assert.match(buildSteps[verifyIdx].run ?? '', /apksigner/);
      assert.match(buildSteps[verifyIdx].run ?? '', /application-debuggable/);
    });
  });
});
