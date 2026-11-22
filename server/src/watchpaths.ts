/**
 * Watch paths: deploy a git service only when a push changes files it cares about (monorepos).
 * Patterns are globs relative to the repository root: `**` crosses folders, `*` and `?` stay within one,
 * a leading `!` excludes. A file counts when it matches an include (or there are none) and no exclude.
 */

function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/^\/+/, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more folders; a trailing `**` matches everything below.
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A plain folder name ("apps/web" or "apps/web/") watches everything inside it too.
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** True when the change touches the watch paths. Unknown changes (null) and no patterns always deploy. */
export function touchesWatchPaths(files: string[] | null, patterns: string[] | null | undefined): boolean {
  const list = (patterns ?? []).map((p) => p.trim()).filter(Boolean);
  if (!list.length || files === null) return true;
  const include = list.filter((p) => !p.startsWith('!')).map(globToRegExp);
  const exclude = list.filter((p) => p.startsWith('!')).map((p) => globToRegExp(p.slice(1)));
  return files.some((f) => (include.length === 0 || include.some((r) => r.test(f))) && !exclude.some((r) => r.test(f)));
}

/** Files a push changed, from the payload's commits; null when the list may be incomplete. */
export function changedFiles(provider: string, payload: any): string[] | null {
  const commits: any[] = Array.isArray(payload?.commits) ? payload.commits : [];
  if (!commits.length) return null;
  // GitHub sends at most 20 commits; GitLab says how many there were in total.
  if (provider === 'gitlab' ? Number(payload.total_commits_count ?? commits.length) > commits.length : commits.length >= 20) return null;
  const files = new Set<string>();
  for (const c of commits) for (const k of ['added', 'modified', 'removed']) for (const f of c?.[k] ?? []) if (typeof f === 'string') files.add(f);
  return [...files];
}

/** Files changed between two commits of a GitHub repository (polling without webhooks); null when unknown. */
export async function githubChangedFiles(repo: string, base: string, head: string, token?: string): Promise<string[] | null> {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(repo.replace(/^git@github\.com:/, 'https://github.com/'));
  if (!m) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/compare/${base}...${head}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'servify', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { files?: { filename: string; previous_filename?: string }[] };
    if (!Array.isArray(body.files) || body.files.length >= 300) return null; // the API caps the list at 300
    return body.files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  } catch {
    return null;
  }
}
