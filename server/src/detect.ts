/**
 * Zero-config builder: inspect a source tree and generate a Dockerfile.
 * Covers the common stacks; a repo with its own Dockerfile always wins.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Detection = { stack: string; dockerfile: string; port: number | null };

const has = (dir: string, f: string) => existsSync(join(dir, f));
const read = (dir: string, f: string) => {
  try {
    return readFileSync(join(dir, f), 'utf8');
  } catch {
    return '';
  }
};

function procfileWeb(dir: string): string | null {
  const p = read(dir, 'Procfile');
  const m = p.match(/^web:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function shellCmd(cmd: string) {
  // JSON-array form through sh so $PORT expands and signals reach the process (exec).
  return `CMD ["/bin/sh", "-c", ${JSON.stringify(`exec ${cmd}`)}]`;
}

function node(dir: string, buildCommand: string | null): Detection {
  let pkg: any = {};
  try {
    pkg = JSON.parse(read(dir, 'package.json'));
  } catch {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};
  const bun = has(dir, 'bun.lockb') || has(dir, 'bun.lock');
  let pm = 'npm';
  let install = 'npm install --no-audit --no-fund';
  if (bun) {
    pm = 'bun';
    install = 'bun install';
  } else if (has(dir, 'pnpm-lock.yaml')) {
    pm = 'pnpm';
    install = 'pnpm install --frozen-lockfile || pnpm install';
  } else if (has(dir, 'yarn.lock')) {
    pm = 'yarn';
    install = 'yarn install --frozen-lockfile || yarn install';
  } else if (has(dir, 'package-lock.json')) {
    install = 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund';
  }
  const run = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${pm} run ${s}`);
  const build = buildCommand ?? (scripts.build ? run('build') : null);
  const base = bun ? 'oven/bun:1-alpine' : 'node:22-alpine';
  const setup = bun ? '' : pm === 'npm' ? '' : 'RUN corepack enable\n';

  const isStaticSpa =
    !scripts.start &&
    !!scripts.build &&
    !deps.next &&
    !deps.nuxt &&
    !deps['@remix-run/serve'] &&
    (deps.vite || deps['react-scripts'] || deps['@angular/core'] || deps.astro || deps.parcel);

  if (isStaticSpa) {
    return {
      stack: `static site (${pm} build)`,
      port: 80,
      dockerfile: `FROM ${base} AS build
WORKDIR /app
${setup}COPY . .
RUN ${install}
RUN ${build}
RUN for d in dist build out .output/public public; do if [ -d "$d" ] && [ -f "$d/index.html" ]; then cp -r "$d" /site; break; fi; done; test -d /site

FROM nginx:1.27-alpine
RUN printf 'server {\\n listen 80;\\n root /usr/share/nginx/html;\\n location / { try_files $uri $uri/ /index.html; }\\n}\\n' > /etc/nginx/conf.d/default.conf
COPY --from=build /site /usr/share/nginx/html
EXPOSE 80
`,
    };
  }

  let start: string;
  const pf = procfileWeb(dir);
  if (pf) start = pf;
  else if (scripts.start) start = pm === 'npm' ? 'npm start' : `${pm} start`;
  else if (deps.next) start = 'npx next start -p ${PORT:-3000}';
  else if (pkg.main) start = `node ${pkg.main}`;
  else {
    const entry = ['server.js', 'index.js', 'app.js', 'main.js', 'server.mjs', 'index.mjs'].find((f) => has(dir, f));
    start = entry ? `node ${entry}` : 'npm start';
  }
  return {
    stack: `node (${pm}${deps.next ? ', next.js' : ''})`,
    port: deps.next ? 3000 : null,
    dockerfile: `FROM ${base}
WORKDIR /app
${setup}COPY . .
RUN ${install}
${build ? `RUN ${build}\n` : ''}ENV NODE_ENV=production
${shellCmd(start)}
`,
  };
}

function python(dir: string, buildCommand: string | null): Detection {
  const reqs = (read(dir, 'requirements.txt') + read(dir, 'pyproject.toml') + read(dir, 'Pipfile')).toLowerCase();
  let install = 'true';
  if (has(dir, 'requirements.txt')) install = 'pip install -r requirements.txt';
  else if (has(dir, 'pyproject.toml')) install = 'pip install .';
  else if (has(dir, 'Pipfile')) install = 'pip install pipenv && pipenv install --system --deploy';
  const mod = ['main.py', 'app.py', 'server.py', 'wsgi.py'].find((f) => has(dir, f))?.replace(/\.py$/, '') ?? 'main';
  let start: string;
  const pf = procfileWeb(dir);
  if (pf) start = pf;
  else if (has(dir, 'manage.py')) start = 'python manage.py runserver 0.0.0.0:${PORT:-8000}';
  else if (reqs.includes('fastapi') || reqs.includes('uvicorn')) start = `uvicorn ${mod}:app --host 0.0.0.0 --port \${PORT:-8000}`;
  else if (reqs.includes('flask') && reqs.includes('gunicorn')) start = `gunicorn -b 0.0.0.0:\${PORT:-8000} ${mod}:app`;
  else if (reqs.includes('flask')) start = `flask --app ${mod} run --host 0.0.0.0 --port \${PORT:-8000}`;
  else start = `python ${mod}.py`;
  return {
    stack: 'python',
    port: 8000,
    dockerfile: `FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY . .
RUN ${install}
${buildCommand ? `RUN ${buildCommand}\n` : ''}${shellCmd(start)}
`,
  };
}

function go(dir: string): Detection {
  return {
    stack: 'go',
    port: 8080,
    dockerfile: `FROM golang:1-alpine AS build
WORKDIR /src
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/app .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/app /app
${procfileWeb(dir) ? shellCmd(procfileWeb(dir)!) : 'CMD ["/app"]'}
`,
  };
}

function rust(dir: string): Detection {
  const name = read(dir, 'Cargo.toml').match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? 'app';
  return {
    stack: 'rust',
    port: 8080,
    dockerfile: `FROM rust:1-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release && cp target/release/${name} /out-bin

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out-bin /app
CMD ["/app"]
`,
  };
}

function deno(dir: string): Detection {
  const cfg = read(dir, 'deno.json') + read(dir, 'deno.jsonc');
  const entry = ['main.ts', 'server.ts', 'mod.ts', 'index.ts'].find((f) => has(dir, f)) ?? 'main.ts';
  const start = /"start"\s*:/.test(cfg) ? 'deno task start' : `deno run -A ${entry}`;
  return {
    stack: 'deno',
    port: 8000,
    dockerfile: `FROM denoland/deno:alpine
WORKDIR /app
COPY . .
RUN deno cache ${entry} || true
${shellCmd(start)}
`,
  };
}

function staticSite(): Detection {
  return {
    stack: 'static (nginx)',
    port: 80,
    dockerfile: `FROM nginx:1.27-alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`,
  };
}

function php(dir: string): Detection {
  return {
    stack: 'php (apache)',
    port: 80,
    dockerfile: `FROM php:8.3-apache
${has(dir, 'composer.json') ? 'COPY --from=composer:2 /usr/bin/composer /usr/bin/composer\n' : ''}WORKDIR /var/www/html
COPY . .
${has(dir, 'composer.json') ? 'RUN apt-get update && apt-get install -y unzip && composer install --no-dev --optimize-autoloader\n' : ''}EXPOSE 80
`,
  };
}

function ruby(dir: string): Detection {
  const pf = procfileWeb(dir);
  const start = pf ?? (has(dir, 'config.ru') ? 'bundle exec rackup -o 0.0.0.0 -p ${PORT:-9292}' : 'ruby app.rb');
  return {
    stack: 'ruby',
    port: 9292,
    dockerfile: `FROM ruby:3.3-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bundle install
${shellCmd(start)}
`,
  };
}

export function detect(dir: string, buildCommand: string | null = null): Detection | null {
  if (has(dir, 'package.json')) return node(dir, buildCommand);
  if (has(dir, 'deno.json') || has(dir, 'deno.jsonc')) return deno(dir);
  if (has(dir, 'requirements.txt') || has(dir, 'pyproject.toml') || has(dir, 'Pipfile') || has(dir, 'manage.py')) return python(dir, buildCommand);
  if (has(dir, 'go.mod')) return go(dir);
  if (has(dir, 'Cargo.toml')) return rust(dir);
  if (has(dir, 'Gemfile')) return ruby(dir);
  if (has(dir, 'composer.json') || has(dir, 'index.php')) return php(dir);
  if (has(dir, 'index.html')) return staticSite();
  return null;
}

export const DEFAULT_IGNORE = `node_modules
.git
.next/cache
.venv
venv
__pycache__
target
.DS_Store
*.log
.env
.env.*
`;
