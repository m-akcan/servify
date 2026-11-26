/** Hand-drawn icon set on a 24px grid, 1.6 stroke. */
const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  power: 'M12 3v8M6.4 6.4a8 8 0 1 0 11.2 0',
  server: 'M4 4h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 14h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM7 7h.01M7 17h.01M11 7h6M11 17h6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  archive: 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  webhook: 'M18 17h-6c-1.1 0-2 .9-2.5 1.9A4 4 0 1 1 3 16M6.6 17l3.1-5.8c.5-1-.1-2.2-.5-3.1a4 4 0 1 1 6.9-4M12 6l3.1 5.7c.5 1 1.7 1.3 2.9 1.3a4 4 0 0 1 0 8',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  certificate: 'M12 2l7 3v6c0 5-3 8.5-7 11-4-2.5-7-6-7-11V5l7-3zM9 12l2 2 4-4',
  minus: 'M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowUpRight: 'M7 17L17 7M8 7h9v9',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  command: 'M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0v6m0-6h6m-6 6v2.5A2.5 2.5 0 1 1 6.5 15H9zm0 0h6m0-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0v2.5a2.5 2.5 0 1 0 2.5-2.5H15z',
  git: 'M6 4v10M18 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 10c0 4-4 4-8 5.5C8 16.2 6.8 16.8 6 18',
  github:
    'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  template: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  rocket:
    'M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9-.8-.8-2.1-.8-2.9-.1zM12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2zM9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5',
  refresh: 'M20 11a8 8 0 0 0-14.7-4.3L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.3L20 16M20 20v-4h-4',
  play: 'M7 5l12 7-12 7V5z',
  stop: 'M6 6h12v12H6z',
  pause: 'M8 5v14M16 5v14',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  terminal: 'M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h3',
  logs: 'M4 6h16M4 10h10M4 14h16M4 18h8',
  chart: 'M3 20h18M6 16v-4M10 16V8M14 16v-6M18 16V5',
  pulse: 'M3 12h4l2.5-6 5 12 2.5-6H21',
  braces: 'M8 4H7a2 2 0 0 0-2 2v3.5A2.5 2.5 0 0 1 2.5 12 2.5 2.5 0 0 1 5 14.5V18a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v3.5a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0-2.5 2.5V18a2 2 0 0 1-2 2h-1',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  cpu: 'M7 7h10v10H7zM10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3',
  memory: 'M3 7h18v10H3zM7 7v10M11 7v10M15 7v10M3 20h18',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  history: 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M12 7v5l3 2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  bot: 'M5 9h14v10H5zM12 5v4M9 14h.01M15 14h.01M12 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM2 13v3M22 13v3',
  key: 'M15 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM11 13l-7 7M7 17l2 2M5 19l2 2',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  home: 'M4 10l8-6 8 6v10H4zM10 20v-6h4v6',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  activity: 'M12 3a6 6 0 0 0-6 6c0 6-2.5 8-2.5 8h17S18 15 18 9a6 6 0 0 0-6-6zM10 20.5a2.2 2.2 0 0 0 4 0',
  network: 'M12 3v6M12 9a3 3 0 1 0 0 .01M5 19a2 2 0 1 0 0-.01M19 19a2 2 0 1 0 0-.01M12 12v2M5 17v-1a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1',
  database: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  sparkle: 'M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3zM19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  alert: 'M12 3l10 18H2L12 3zM12 10v4M12 17.5h.01',
  hash: 'M5 9h14M5 15h14M10 3L8 21M16 3l-2 18',
  cloud: 'M7 18a5 5 0 0 1-.7-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 9H7z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  scale: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6',
  drag: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  wave: 'M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0',
  dot: 'M12 12h.01',
  filter: 'M4 5h16l-6 8v6l-4-2v-4L4 5z',
  pin: 'M12 21v-6M7 15h10l-1.5-4V5h-7v6L7 15z',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  upload: 'M12 20V8M7 13l5-5 5 5M5 4h14',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, stroke = 1.6, className, style }: { name: IconName | string; size?: number; stroke?: number; className?: string; style?: React.CSSProperties }) {
  const d = P[name] ?? P.box;
  const isDot = name === 'more' || name === 'drag' || name === 'dot';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={isDot ? stroke * 1.9 : stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

import { BRAND_ICONS } from './brandIcons.ts';

/** A brand logo (simple-icons) drawn in its brand colour — or in the text colour for near-black marks. */
export function BrandMark({ icon, size = 16, className = '', inherit = false }: { icon: string; size?: number; className?: string; inherit?: boolean }) {
  const b = BRAND_ICONS[icon];
  if (!b) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`brand-mark ${className}`} aria-label={b.title} role="img" style={inherit ? undefined : { color: b.neutral ? 'var(--text)' : b.hex }}>
      <path d={b.path} fill="currentColor" />
    </svg>
  );
}

export function hasBrand(icon: string) {
  return icon in BRAND_ICONS;
}

/** Fallback monogram tiles for services without a known logo. */
const GLYPHS: Record<string, { mono: string; hue: string }> = {
  postgres: { mono: 'Pg', hue: '#7aa7ff' },
  // Lettermarks for apps without a logo in simple-icons
  minecraft: { mono: 'Mc', hue: '#62b47a' },
  nocodb: { mono: 'Nc', hue: '#8f7bff' },
  redis: { mono: 'Rd', hue: '#ff7a6b' },
  mysql: { mono: 'My', hue: '#5ec8e8' },
  mongo: { mono: 'Mg', hue: '#6ad48f' },
  bucket: { mono: 'S3', hue: '#ff9f5a' },
  wave: { mono: 'Wh', hue: '#d4f25a' },
  globe: { mono: 'Nx', hue: '#5fe3a1' },
  nginx: { mono: 'Nx', hue: '#5fe3a1' },
  table: { mono: 'Ad', hue: '#c9a7ff' },
  flow: { mono: 'n8', hue: '#ff7aa8' },
  pulse: { mono: 'Up', hue: '#6ad48f' },
  spark: { mono: 'Ol', hue: '#ecebe4' },
  node: { mono: 'Js', hue: '#9be564' },
  python: { mono: 'Py', hue: '#ffd25a' },
  caddy: { mono: 'Cd', hue: '#5fe3a1' },
};

export function ServiceGlyph({ icon, name, size = 34 }: { icon: string; name: string; size?: number }) {
  const g = GLYPHS[icon];
  const fontSize = Math.round(size * 0.36);
  const style: React.CSSProperties = { width: size, height: size, borderRadius: Math.round(size * 0.3), fontSize };
  const brand = BRAND_ICONS[icon];
  if (brand) {
    return (
      <div className="glyph glyph-brand" title={brand.title} style={{ ...style, ['--hue' as any]: brand.neutral ? 'var(--text-2)' : brand.hex }}>
        <BrandMark icon={icon} size={Math.round(size * 0.52)} inherit />
      </div>
    );
  }
  if (g) {
    return (
      <div className="glyph" style={{ ...style, ['--hue' as any]: g.hue }}>
        {g.mono}
      </div>
    );
  }
  if (icon === 'cron') {
    return (
      <div className="glyph" title="Scheduled job" style={{ ...style, ['--hue' as any]: '#f2b84b' }}>
        <Icon name="clock" size={Math.round(size * 0.5)} />
      </div>
    );
  }
  const iconName = icon === 'git' ? 'github' : icon === 'folder' ? 'folder' : 'box';
  return (
    <div className="glyph glyph-neutral" style={{ ...style, ['--hue' as any]: 'var(--text-2)' }}>
      {icon === 'box' ? name.slice(0, 2).replace(/^./, (c) => c.toUpperCase()) : <Icon name={iconName} size={Math.round(size * 0.5)} />}
    </div>
  );
}
