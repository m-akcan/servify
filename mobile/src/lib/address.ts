/**
 * Servify addresses. People type "192.168.1.5:7700" or "servify.example.com"; we turn that into a
 * base URL. Plain http:// is only allowed for addresses that stay on a home network or VPN, because
 * the password and the token would otherwise cross the internet unencrypted.
 */
export type ParsedAddress = { ok: true; url: string; host: string; insecure: boolean } | { ok: false; error: string };

function privateIPv4(h: string): boolean {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT range: Tailscale and other VPNs
  );
}

function privateIPv6(h: string): boolean {
  const v = h.replace(/^\[|\]$/g, '').toLowerCase();
  return v === '::1' || v.startsWith('fd') || v.startsWith('fc') || v.startsWith('fe80');
}

/** Hostnames that only resolve inside a home network or VPN. */
function localName(h: string): boolean {
  if (!h.includes('.')) return true; // "homeserver", "nas"
  return /\.(local|lan|home|internal|intranet|home\.arpa|ts\.net)$/.test(h) || h === 'localhost' || h.endsWith('.localhost');
}

export function isPrivateHost(host: string): boolean {
  return privateIPv4(host) || privateIPv6(host) || localName(host);
}

export function parseAddress(input: string): ParsedAddress {
  let raw = input.trim().replace(/\/+$/, '');
  if (!raw) return { ok: false, error: 'Enter the address of your Servify.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // No scheme: LAN and VPN addresses are almost always plain HTTP, public names HTTPS.
    const hostPart = raw.split('/')[0].replace(/:\d+$/, '');
    raw = `${isPrivateHost(hostPart.toLowerCase()) ? 'http' : 'https'}://${raw}`;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "That doesn't look like an address. Example: 192.168.1.20:7700" };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Use an http:// or https:// address.' };
  if (u.username || u.password) return { ok: false, error: "Don't put a user name or password in the address." };
  const host = u.hostname.toLowerCase();
  const insecure = u.protocol === 'http:';
  if (insecure && !isPrivateHost(host)) {
    return { ok: false, error: `${host} is a public address, so it needs https://. Plain http:// is only allowed on your home network or VPN.` };
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.protocol}//${u.host}${path}`, host: u.host, insecure };
}
