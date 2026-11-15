import { rm } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const targets = ['node_modules', 'dist', '.next'];

async function walk(dir, depth = 0) {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (targets.includes(entry.name)) {
      await rm(full, { recursive: true, force: true });
      console.log(`removed ${full}`);
      continue;
    }
    if (entry.name === '.git') continue;
    await walk(full, depth + 1);
  }
}

await walk(root);
