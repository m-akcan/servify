/**
 * The base image of a Dockerfile build: the image the final stage (or the build target) starts from, following
 * `FROM <earlier stage>` back to a registry image. Only `ARG`s declared before the first `FROM` apply to `FROM`
 * lines (Docker's own rule); build arguments override their defaults. Anything Servify can't resolve for certain —
 * an unset variable (TARGETARCH…), `FROM scratch`, a ref pinned by digest — gives null, never a guess.
 */

export type BaseImage = {
  /** The image reference, as written once variables are filled in ("nextcloud:35.0.3"). */
  ref: string;
  /** The build argument the whole tag comes from (`FROM nextcloud:${NEXTCLOUD_TAG}`): a new tag can be set through it. */
  tagArg: string | null;
};

/** Logical lines: comments dropped, continuations joined (honours the `# escape=` parser directive). */
function logicalLines(text: string): string[] {
  const raw = text.replace(/^﻿/, '').split(/\r?\n/);
  let escape = '\\';
  // Parser directives sit at the very top, before any instruction, comment or blank line.
  for (const l of raw) {
    const m = /^#\s*([a-z]+)\s*=\s*(\S+)\s*$/i.exec(l);
    if (!m) break;
    if (m[1].toLowerCase() === 'escape' && (m[2] === '`' || m[2] === '\\')) escape = m[2];
  }
  const out: string[] = [];
  let cur = '';
  for (const line of raw) {
    const t = line.trim();
    if (!cur && (t === '' || t.startsWith('#'))) continue;
    if (cur && t.startsWith('#')) continue; // comments inside a continued instruction are skipped
    if (t.endsWith(escape)) {
      cur += t.slice(0, -1) + ' ';
      continue;
    }
    out.push((cur + t).trim());
    cur = '';
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Fill in $VAR, ${VAR}, ${VAR:-default} and ${VAR:+alt}. Null when a variable has no value (can't know the image). */
function substitute(s: string, vars: Map<string, string | null>): string | null {
  let unknown = false;
  const lookup = (name: string) => {
    const v = vars.get(name);
    return v === undefined ? null : v;
  };
  const out = s.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, braced, op, word, bare) => {
    const name = braced ?? bare;
    const v = lookup(name);
    const set = v !== null && v !== '';
    if (op === ':-' || op === '-') {
      if (set || (op === '-' && v === '')) return v!;
      return word ?? '';
    }
    if (op === ':+' || op === '+') return set || (op === '+' && v === '') ? word ?? '' : '';
    if (v === null) unknown = true;
    return v ?? '';
  });
  return unknown ? null : out;
}

/** "FROM nextcloud:${NEXTCLOUD_TAG}" → "NEXTCLOUD_TAG": the tag is exactly one variable. */
function tagVariable(rawRef: string): string | null {
  const m = /^[^@]*?:(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*))$/.exec(rawRef);
  if (!m) return null;
  // The colon must separate the tag, not a registry port ("localhost:5000/app" has a slash after it).
  const colon = rawRef.lastIndexOf(':');
  return colon > rawRef.lastIndexOf('/') ? (m[1] ?? m[2]) : null;
}

export function baseImageOf(dockerfile: string, buildArgs: Record<string, string> = {}, target: string | null = null): BaseImage | null {
  const globals = new Map<string, string | null>();
  const stages: { name: string | null; raw: string }[] = [];
  for (const line of logicalLines(dockerfile)) {
    const m = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const ins = m[1].toUpperCase();
    if (ins === 'ARG' && !stages.length) {
      // ARG NAME[=default] [NAME2[=default2] …]; quotes around a default are stripped.
      for (const part of m[2].match(/[A-Za-z_][A-Za-z0-9_]*(?:=(?:"[^"]*"|'[^']*'|\S*))?/g) ?? []) {
        const eq = part.indexOf('=');
        const name = eq < 0 ? part : part.slice(0, eq);
        const def = eq < 0 ? null : part.slice(eq + 1).replace(/^(["'])(.*)\1$/, '$2');
        globals.set(name, name in buildArgs ? buildArgs[name] : def);
      }
    } else if (ins === 'FROM') {
      const words = m[2].split(/\s+/).filter((w) => !w.startsWith('--'));
      if (!words.length) continue;
      const as = words.length >= 3 && words[1].toUpperCase() === 'AS' ? words[2] : null;
      stages.push({ name: as, raw: words[0] });
    }
  }
  if (!stages.length) return null;
  let idx = stages.length - 1;
  if (target) {
    idx = stages.findIndex((s) => s.name?.toLowerCase() === target.toLowerCase());
    if (idx < 0) return null;
  }
  // Follow `FROM <earlier stage>` back to an image (a stage name only counts for stages before it).
  for (let hops = 0; hops <= stages.length; hops++) {
    const st = stages[idx];
    const ref = substitute(st.raw, globals);
    if (!ref) return null;
    const prev = stages.slice(0, idx).findLastIndex((s) => s.name?.toLowerCase() === ref.toLowerCase());
    if (prev >= 0) {
      idx = prev;
      continue;
    }
    if (ref.toLowerCase() === 'scratch' || ref.includes('@') || !/^[a-z0-9][a-z0-9._\-/:]*$/i.test(ref)) return null;
    const v = tagVariable(st.raw);
    return { ref, tagArg: v && globals.has(v) ? v : null };
  }
  return null;
}

/**
 * The base image digests a BuildKit build resolved, from its plain-progress log:
 * `#4 [1/2] FROM docker.io/library/alpine:3.20@sha256:…` → { 'docker.io/library/alpine:3.20': ['sha256:…'] }.
 */
export function fromDigestsInLog(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of lines) {
    const m = /^#\d+ \[[^\]]*\] FROM (\S+?)@(sha256:[0-9a-f]{64})\b/.exec(l);
    if (!m) continue;
    const list = out.get(m[1]) ?? [];
    if (!list.includes(m[2])) list.push(m[2]);
    out.set(m[1], list);
  }
  return out;
}
