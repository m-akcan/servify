import { Icon, BrandMark } from './Icon.tsx';
import { BRAND_ICONS } from './brandIcons.ts';

/** Line icons offered for projects. */
export const PROJECT_ICONS = [
  'globe', 'database', 'server', 'cloud', 'rocket', 'bot', 'zap', 'chart', 'terminal', 'shield', 'mail', 'home',
  'key', 'layers', 'sparkle', 'network', 'user', 'cpu', 'branch', 'box', 'folder', 'webhook', 'pulse', 'bell',
] as const;

/** Brand logos offered for projects (each logo once, even where several keys share it). */
export const PROJECT_LOGOS = Object.entries(BRAND_ICONS)
  .filter(([key, b], i, all) => all.findIndex(([, o]) => o.title === b.title) === i && key !== 'static')
  .map(([key, b]) => ({ key, title: b.title }));

/** The project's icon tinted in its color, or its color dot when it has no icon. */
export function ProjectMark({ project, size = 18 }: { project: { color: string; icon?: string | null }; size?: number }) {
  const icon = project.icon ?? '';
  const kind = icon.slice(0, 2);
  const value = icon.slice(2);
  if (!value || !['i:', 'b:', 'e:'].includes(kind)) return <span className="crumb-dot" style={{ background: project.color }} />;
  return (
    <span className="project-mark" style={{ width: size, height: size, ['--pc' as any]: project.color }} aria-hidden>
      {kind === 'i:' && <Icon name={value} size={Math.round(size * 0.64)} />}
      {kind === 'b:' && <BrandMark icon={value} size={Math.round(size * 0.62)} />}
      {kind === 'e:' && <span className="project-mark-emoji" style={{ fontSize: Math.round(size * 0.66) }}>{value}</span>}
    </span>
  );
}
