/**
 * Ultra-fast (< 0.5s) shared-store pointer seeder & up-to-date verifier for clean git worktrees.
 * Author: Vadim Yakovets [Vex788] vyakovets@plexsupply.com
 *
 * Imports ONLY lightweight `storage/*` modules (never `@ladybugdb/core` or Tree-sitter),
 * seeding `<store>/checkouts/<slot>` directly from `<store>/commits/<HEAD>-<featureKey>`
 * when the worktree is pristine at `HEAD`. Exits 0 on fast-path completion, or exits 2
 * so the caller falls through to the full `analyze` pipeline.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCurrentCommit, isWorkingTreePristine } from '../storage/git.js';
import { acquireIndexLock, requireExclusiveIndexLock } from '../storage/index-lock.js';
import {
  canonicalizePath,
  findRegistryEntryByRepoPath,
  readRegistry,
  registerRepo,
  registryPathEquals,
  saveMeta,
} from '../storage/repo-manager.js';
import { loadMeta, type RepoMeta } from '../storage/repo-meta.js';
import { resolveSharedStore } from '../storage/shared-store.js';
import {
  GRAPH_CLONE_MARKER,
  withStoreLock,
  writeSharedStorePointer,
} from '../storage/shared-store-lifecycle.js';
import { retainSharedVectorArtifact } from '../storage/shared-vector-artifact.js';
import { LBUG_DIRECTORY } from '../storage/storage-constants.js';

const FAST_FALLBACK_EXIT = 2;

export interface FastRunnerProbe {
  executablePath: string;
  nodeVersion: string;
  distRoot: string;
  cliIndexPath: string;
  cliIndexDigest: string;
  manifestPath: string;
  cliVersion: string;
  manifestTouchMs: number;
}

let cachedRunnerProbe: FastRunnerProbe | null | undefined;

export function resolveFastRunnerProbe(moduleUrl: string = import.meta.url): FastRunnerProbe | null {
  if (moduleUrl === import.meta.url && cachedRunnerProbe !== undefined) {
    return cachedRunnerProbe;
  }
  try {
    const executablePath = realpathSync(process.execPath);
    const selfPath = realpathSync(fileURLToPath(moduleUrl));
    const distRoot = realpathSync(path.resolve(path.dirname(selfPath), '..'));
    const cliIndexPath = realpathSync(path.join(distRoot, 'cli', 'index.js'));
    const cliIndexDigest =
      'sha256:' + createHash('sha256').update(readFileSync(cliIndexPath)).digest('hex');
    const manifestPath = realpathSync(path.resolve(distRoot, '..', 'package.json'));
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    const cliVersion = typeof pkg.version === 'string' ? pkg.version : '';
    const stPkg = statSync(manifestPath);
    const stCli = statSync(cliIndexPath);
    const manifestTouchMs = Math.max(stPkg.mtimeMs, stPkg.ctimeMs, stCli.mtimeMs, stCli.ctimeMs);
    const probe: FastRunnerProbe = {
      executablePath,
      nodeVersion: process.version,
      distRoot,
      cliIndexPath,
      cliIndexDigest,
      manifestPath,
      cliVersion,
      manifestTouchMs,
    };
    if (moduleUrl === import.meta.url) cachedRunnerProbe = probe;
    return probe;
  } catch {
    if (moduleUrl === import.meta.url) cachedRunnerProbe = null;
    return null;
  }
}

export function isFastRunnerCurrent(
  meta: RepoMeta | null | undefined,
  probe: FastRunnerProbe | null = resolveFastRunnerProbe(),
): boolean {
  if (!meta || !probe) return false;
  const r = meta.runnerIdentity;
  if (!r || r.schemaVersion !== 4) return false;
  if (r.cliVersion !== probe.cliVersion) return false;
  if (
    r.runtime?.executablePath !== probe.executablePath ||
    r.runtime?.version !== probe.nodeVersion
  ) {
    return false;
  }
  if (r.build?.rootPath !== probe.distRoot) return false;
  if (
    r.invokedArtifact?.path !== probe.cliIndexPath ||
    r.invokedArtifact?.digest !== probe.cliIndexDigest
  ) {
    return false;
  }
  if (r.dependencyRuntime?.manifestPath !== probe.manifestPath) return false;
  const indexedMs = Date.parse(meta.indexedAt);
  if (!Number.isFinite(indexedMs) || probe.manifestTouchMs > indexedMs) return false;
  return true;
}

async function removeSlotPrivateGraphs(slotDir: string): Promise<void> {
  await fs.rm(path.join(slotDir, LBUG_DIRECTORY), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(slotDir, GRAPH_CLONE_MARKER), { force: true }).catch(() => {});
  const entries = await fs.readdir(slotDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry.startsWith('lbug.generation.') || entry.startsWith('lbug.new.')) {
      await fs.rm(path.join(slotDir, entry), { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function tryFastSeed(targetArg: string): Promise<boolean> {
  const repoPath = canonicalizePath(path.resolve(targetArg));
  const layout = resolveSharedStore(repoPath);
  if (!layout) return false;

  const head = getCurrentCommit(repoPath);
  if (!head || !isWorkingTreePristine(repoPath)) return false;

  await fs.mkdir(layout.checkoutSlot, { recursive: true });
  const lock = await acquireIndexLock(layout.checkoutSlot, { timeoutMs: 2_000 });
  try {
    requireExclusiveIndexLock(lock, `Slot busy: ${layout.checkoutSlot}`);

    const probe = resolveFastRunnerProbe();
    if (!probe) return false;

    const existing = await loadMeta(layout.checkoutSlot);
    if (existing) {
      if (existing.incrementalInProgress || existing.embeddingJob || existing.embeddingCheckpoint) {
        return false;
      }
      if (
        existing.lastCommit === head &&
        existing.graphPath &&
        existsSync(existing.graphPath) &&
        isFastRunnerCurrent(existing, probe)
      ) {
        const entries = await readRegistry();
        const prev = findRegistryEntryByRepoPath(entries, repoPath);
        if (
          !prev ||
          !registryPathEquals(canonicalizePath(prev.storagePath), canonicalizePath(layout.checkoutSlot))
        ) {
          await registerRepo(repoPath, existing, {
            allowDuplicateName: true,
            storagePath: layout.checkoutSlot,
            dropBranches: Boolean(prev),
          });
        }
        await writeSharedStorePointer(repoPath, layout);
        process.stdout.write(`  Already up to date\n`);
        return true;
      }
      // Clean checkout moved to another HEAD or runner identity updated: fall through to check if
      // a current `commits/<head>-*` graph is published in the shared store so we can re-point in < 0.5s.
    }

    let names: string[];
    try {
      names = await fs.readdir(layout.commitsDir);
    } catch {
      return false;
    }

    const prefix = `${head}-`;
    const candidates = names.filter((n) => n.startsWith(prefix)).sort();
    if (candidates.length === 0) return false;

    let seededMeta: RepoMeta | null = null;
    await withStoreLock(layout, 'publish', async () => {
      for (const dirName of candidates) {
        const commitDir = path.join(layout.commitsDir, dirName);
        const graphFile = path.join(commitDir, LBUG_DIRECTORY);
        if (!existsSync(graphFile)) continue;
        const commitMeta = await loadMeta(commitDir);
        if (!commitMeta || commitMeta.lastCommit !== head || !isFastRunnerCurrent(commitMeta, probe)) {
          continue;
        }

        if (commitMeta.vectorGeneration) {
          try {
            await retainSharedVectorArtifact(commitDir, layout.checkoutSlot, commitMeta.vectorGeneration);
          } catch {
            continue;
          }
        }
        await removeSlotPrivateGraphs(layout.checkoutSlot);
        const slotMeta: RepoMeta = {
          ...commitMeta,
          repoPath,
          storagePath: layout.checkoutSlot,
          graphPath: graphFile,
          lastCommit: head,
        };
        delete slotMeta.incrementalInProgress;
        await saveMeta(layout.checkoutSlot, slotMeta);
        seededMeta = slotMeta;
        break;
      }
    });

    if (!seededMeta) return false;

    const entries = await readRegistry();
    const prev = findRegistryEntryByRepoPath(entries, repoPath);
    const moved =
      prev !== undefined &&
      !registryPathEquals(canonicalizePath(prev.storagePath), canonicalizePath(layout.checkoutSlot));
    await registerRepo(repoPath, seededMeta, {
      allowDuplicateName: true,
      storagePath: layout.checkoutSlot,
      dropBranches: moved,
    });
    await writeSharedStorePointer(repoPath, layout);
    process.stderr.write(`Shared store: seeded from commit graph ${head.slice(0, 12)}.\n`);
    process.stdout.write(`  Already up to date\n`);
    return true;
  } finally {
    lock.release();
  }
}

const isDirectCliEntry = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectCliEntry) {
  const target = process.argv[2] || '.';
  tryFastSeed(target)
    .then((ok) => {
      process.exit(ok ? 0 : FAST_FALLBACK_EXIT);
    })
    .catch(() => {
      process.exit(FAST_FALLBACK_EXIT);
    });
}
