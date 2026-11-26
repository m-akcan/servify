import type { ServiceView } from '../../../web/src/lib/types.ts';

/** One short line about where a service comes from. */
export function sourceLine(s: Pick<ServiceView, 'source'>): string {
  const src = s.source;
  switch (src.type) {
    case 'image':
      return src.image;
    case 'git':
      return `${src.repo.replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, '')}${src.branch ? `#${src.branch}` : ''}`;
    case 'local':
      return src.path;
    case 'upload':
      return src.label || 'uploaded folder';
    case 'external':
      return `→ ${src.host}:${src.port}`;
    case 'redirect':
      return `redirects to ${src.to}`;
  }
}

export function publicUrls(s: ServiceView): string[] {
  const fromDomains = (s.domainInfo ?? []).map((d) => d.url);
  if (fromDomains.length) return fromDomains;
  return s.url ? [s.url] : [];
}

export const hostOf = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
