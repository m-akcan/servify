/**
 * What connecting services on the canvas means (drag a service's ⊕): "this service uses that one". Mirrors
 * connectionVariables() on the server: a template's connection variables (DATABASE_URL for Postgres, AMQP_URL for
 * RabbitMQ…), else the provider's own *_URL variables, else its private hostname.
 */
import type { ServiceView, Template } from './types.ts';

const PROVIDER_CATEGORIES = ['database', 'cache', 'queue', 'storage'];
const DUMPS = ['pg_dumpall', 'mysqldump', 'mongodump'];

export const templateOf = (s: ServiceView, templates: Template[]) => (s.templateId ? templates.find((t) => t.id === s.templateId) ?? null : null);

/** Something other services use (a database, cache, queue, storage, or a template apps connect to). */
export function isProvider(s: ServiceView, templates: Template[]): boolean {
  const tpl = templateOf(s, templates);
  if (tpl) return !!tpl.connect || PROVIDER_CATEGORIES.includes(tpl.category);
  return DUMPS.includes((s as any).backupMethod ?? '');
}

/** Templates an app can add and connect to in one go, in gallery order. */
export function connectableTemplates(templates: Template[]): Template[] {
  const order = ['database', 'cache', 'queue', 'storage', 'tool', 'app'];
  return templates.filter((t) => t.connect).sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}

/** The variables `consumerEnv`'s service gets to use `provider`. Taken names get the provider's name as a prefix. */
export function connectionVariables(provider: ServiceView, templates: Template[], consumerEnv: Record<string, string> = {}): Record<string, string> {
  const tpl = templateOf(provider, templates);
  const ref = (k: string) => `\${{ ${provider.slug}.${k} }}`;
  const pairs: [string, string][] = tpl?.connect
    ? Object.entries(tpl.connect).map(([k, v]) => [k, v.includes('${{') ? v.replaceAll('{svc}', provider.slug) : ref(v)])
    : Object.keys(provider.env)
        .filter((k) => /_URL$/.test(k) && !/PUBLIC/.test(k))
        .map((k) => [k, ref(k)]);
  const prefix = provider.slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (!pairs.length) pairs.push([`${prefix}_HOST`, ref('SERVIFY_PRIVATE_DOMAIN')]);
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k in consumerEnv && consumerEnv[k] !== v ? `${prefix}_${k}` : k] = v;
  return out;
}

/** What a dragged ⊕ would do, for the hint next to the pointer. */
export function connectHint(from: ServiceView, over: ServiceView | null, templates: Template[]): string {
  if (over) return `${from.name} will use ${over.name}`;
  return isProvider(from, templates) ? `Drop to add a service that uses ${from.name}` : `Drop to add something ${from.name} uses`;
}
