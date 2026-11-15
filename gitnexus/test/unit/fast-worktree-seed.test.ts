import { describe, expect, it } from 'vitest';
import { isFastRunnerCurrent, type FastRunnerProbe } from '../../src/cli/fast-worktree-seed.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const PROBE: FastRunnerProbe = {
  executablePath: '/opt/node22/bin/node',
  nodeVersion: 'v22.23.5',
  distRoot: '/opt/gitnexus/lib/node_modules/gitnexus/dist',
  cliIndexPath: '/opt/gitnexus/lib/node_modules/gitnexus/dist/cli/index.js',
  cliIndexDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  manifestPath: '/opt/gitnexus/lib/node_modules/gitnexus/package.json',
  cliVersion: '1.6.12',
  manifestTouchMs: Date.parse('2026-11-15T18:00:00.000Z'),
};

function makeMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    repoPath: '/repo',
    storagePath: '/store/checkouts/repo-1234',
    lastCommit: 'b7b1e01c21b843ef07c8c96db12a5b2872cba083',
    indexedAt: '2026-11-15T18:05:00.000Z',
    stats: { files: 10, nodes: 20, edges: 30 },
    runnerIdentity: {
      schemaVersion: 4,
      cliVersion: '1.6.12',
      runtime: {
        executablePath: PROBE.executablePath,
        version: PROBE.nodeVersion,
        platform: 'linux',
        architecture: 'x64',
        modulesAbi: '127',
        libc: 'glibc:2.41',
      },
      invokedArtifact: {
        path: PROBE.cliIndexPath,
        digest: PROBE.cliIndexDigest,
      },
      build: {
        kind: 'distribution',
        rootPath: PROBE.distRoot,
        canonicalization: 'gitnexus-analyzer-build-v2',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      dependencyRuntime: {
        manifestPath: PROBE.manifestPath,
        lockfilePath: null,
        canonicalization: 'gitnexus-analyzer-dependency-runtime-v4',
        packageCount: 226,
        artifactCount: 9900,
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
    },
    ...overrides,
  };
}

describe('isFastRunnerCurrent', () => {
  it('accepts metadata matching current runner probe and indexed after manifest touch', () => {
    expect(isFastRunnerCurrent(makeMeta(), PROBE)).toBe(true);
  });

  it('rejects missing runnerIdentity or mismatched CLI digest / rootPath / executablePath', () => {
    expect(isFastRunnerCurrent(makeMeta({ runnerIdentity: undefined }), PROBE)).toBe(false);

    const changedDigest = makeMeta();
    changedDigest.runnerIdentity!.invokedArtifact!.digest = 'sha256:' + 'f'.repeat(64);
    expect(isFastRunnerCurrent(changedDigest, PROBE)).toBe(false);

    const changedRoot = makeMeta();
    changedRoot.runnerIdentity!.build.rootPath = '/other/prefix/dist';
    expect(isFastRunnerCurrent(changedRoot, PROBE)).toBe(false);

    const changedNode = makeMeta();
    changedNode.runnerIdentity!.runtime.executablePath = '/usr/bin/node';
    expect(isFastRunnerCurrent(changedNode, PROBE)).toBe(false);
  });

  it('rejects metadata indexed before package.json was updated or reinstalled', () => {
    const olderIndex = makeMeta({ indexedAt: '2026-11-15T17:59:59.000Z' });
    expect(isFastRunnerCurrent(olderIndex, PROBE)).toBe(false);
  });
});
