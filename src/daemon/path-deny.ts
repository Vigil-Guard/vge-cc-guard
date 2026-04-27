import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// Patterns from PRD §7.11 — all 12 (superset of Sprint 2 "8 fixed patterns")
const HOME_PREFIX_PATTERNS = [
  '/.ssh/',
  '/.aws/credentials',
  '/.aws/config',
  '/.kube/config',
  '/.config/gcloud/',
  '/.gcp/',
];

const BASENAME_EXACT = ['.env'] as const;

const BASENAME_STARTS_WITH = ['id_rsa', 'id_ed25519', 'id_ecdsa'];

const BASENAME_CONTAINS = ['credentials', 'secrets'];

function matchesDenyList(resolvedPath: string): boolean {
  const home = os.homedir();
  const base = path.basename(resolvedPath).toLowerCase();

  // Prefix patterns (home-anchored)
  for (const pattern of HOME_PREFIX_PATTERNS) {
    const prefix = home + pattern;
    if (resolvedPath === prefix || resolvedPath.startsWith(prefix)) return true;
    // Also match exact path for patterns without trailing slash
    if (!pattern.endsWith('/') && resolvedPath === home + pattern) return true;
  }

  // .env: exact match OR ends with .env (e.g. prod.env, dev.env)
  if (BASENAME_EXACT.some((p) => base === p || base.endsWith(p))) return true;

  // id_rsa*, id_ed25519*, id_ecdsa* — basename prefix match
  for (const prefix of BASENAME_STARTS_WITH) {
    if (base.startsWith(prefix)) return true;
  }

  // *credentials*, *secrets* — basename contains match
  for (const fragment of BASENAME_CONTAINS) {
    if (base.includes(fragment)) return true;
  }

  return false;
}

export function checkPath(rawPath: string): { denied: boolean; resolvedPath: string } {
  const expanded = expandTilde(rawPath);
  const resolved = path.resolve(expanded);

  let finalPath = resolved;
  try {
    finalPath = fs.realpathSync(resolved);
  } catch {
    // ENOENT or broken symlink — use pre-realpath result
  }

  return { denied: matchesDenyList(finalPath), resolvedPath: finalPath };
}

