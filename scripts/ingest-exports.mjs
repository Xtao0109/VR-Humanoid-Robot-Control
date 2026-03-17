import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const val = args[idx + 1];
  if (!val || val.startsWith('--')) return true;
  return val;
}

function hasFlag(name) {
  return args.includes(name);
}

const sourceDir = path.resolve(String(getArg('--source', path.join(os.homedir(), 'Downloads'))));
const targetDir = path.resolve(String(getArg('--target', path.join(process.cwd(), 'data_collector', 'collector1'))));
const prefix = String(getArg('--prefix', 'vr-demonstrations'));
const watchMode = hasFlag('--watch');
const copyMode = hasFlag('--copy');
const intervalMs = Number(getArg('--interval', '1500'));
const dryRun = hasFlag('--dry-run');

const manifestPath = path.join(targetDir, '.ingested-manifest.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRegex(filePrefix) {
  const escaped = filePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-(session|episodes|events)-(\\d{8}_\\d{6})\\.(json|jsonl)$`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readManifest() {
  try {
    const text = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.processed)) return new Set(parsed.processed);
  } catch (_) {
    // ignore
  }
  return new Set();
}

async function writeManifest(processedSet) {
  const payload = { processed: [...processedSet].sort(), updatedAt: new Date().toISOString() };
  await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function listCandidateFiles(dir, regex) {
  const files = await fs.readdir(dir, { withFileTypes: true });
  const groups = new Map();

  for (const entry of files) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(regex);
    if (!m) continue;
    const [, kind, ts] = m;
    if (!groups.has(ts)) groups.set(ts, {});
    groups.get(ts)[kind] = entry.name;
  }

  return groups;
}

function completeGroups(groups) {
  const result = [];
  for (const [ts, kinds] of groups.entries()) {
    if (kinds.session && kinds.episodes && kinds.events) {
      result.push({ ts, ...kinds });
    }
  }
  result.sort((a, b) => a.ts.localeCompare(b.ts));
  return result;
}

async function moveOrCopyOne(src, dst) {
  if (copyMode) {
    await fs.copyFile(src, dst);
    return;
  }
  try {
    await fs.rename(src, dst);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await fs.copyFile(src, dst);
      await fs.unlink(src);
      return;
    }
    throw e;
  }
}

async function resolveDestinationPath(dst) {
  try {
    await fs.access(dst);
  } catch (_) {
    return dst;
  }

  const parsed = path.parse(dst);
  let i = 1;
  while (i < 1000) {
    const candidate = path.join(parsed.dir, `${parsed.name}_dup${i}${parsed.ext}`);
    try {
      await fs.access(candidate);
      i += 1;
    } catch (_) {
      return candidate;
    }
  }
  throw new Error(`目标目录重名过多，无法写入: ${dst}`);
}

async function ingestOnce() {
  await ensureDir(targetDir);
  const processed = await readManifest();
  const regex = buildRegex(prefix);

  const groups = await listCandidateFiles(sourceDir, regex);
  const ready = completeGroups(groups).filter((g) => !processed.has(g.ts));

  if (!ready.length) {
    return { moved: 0, groups: 0 };
  }

  let moved = 0;

  for (const g of ready) {
    const filenames = [g.session, g.episodes, g.events];

    for (const name of filenames) {
      const src = path.join(sourceDir, name);
      const dstRaw = path.join(targetDir, name);
      const dst = await resolveDestinationPath(dstRaw);

      if (dryRun) {
        console.log(`[dry-run] ${src} -> ${dst}`);
        moved += 1;
        continue;
      }

      await moveOrCopyOne(src, dst);
      moved += 1;
      console.log(`[ingest] ${name} -> ${targetDir}`);
    }

    processed.add(g.ts);
  }

  if (!dryRun) {
    await writeManifest(processed);
  }

  return { moved, groups: ready.length };
}

async function main() {
  console.log(`[collector-ingest] source=${sourceDir}`);
  console.log(`[collector-ingest] target=${targetDir}`);
  console.log(`[collector-ingest] mode=${watchMode ? 'watch' : 'once'} ${copyMode ? '(copy)' : '(move)'}`);

  if (!watchMode) {
    const result = await ingestOnce();
    console.log(`[collector-ingest] done: groups=${result.groups}, files=${result.moved}`);
    return;
  }

  while (true) {
    try {
      const result = await ingestOnce();
      if (result.groups > 0) {
        console.log(`[collector-ingest] ingested groups=${result.groups}, files=${result.moved}`);
      }
    } catch (e) {
      console.error('[collector-ingest] error:', e?.message || e);
    }
    await sleep(intervalMs);
  }
}

main().catch((e) => {
  console.error('[collector-ingest] fatal:', e?.message || e);
  process.exit(1);
});
