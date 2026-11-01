import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';

export const HOSTED_CHROMIUM_ARGS: readonly string[] = Object.freeze([
  '--proxy-bypass-list=<-loopback>',
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
]);

const FORBIDDEN_TLDS = Object.freeze([
  '.local',
  '.localhost',
  '.internal',
  '.invalid',
  '.lan',
  '.home',
  '.corp',
  '.test',
  '.example',
  '.arpa',
  '.onion',
]);

function parseIpv6Hextets(ip: string): number[] | null {
  if (ip.includes('%')) return null;
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let ipv4Hextets: number[] = [];

  const lastRight = right[right.length - 1];
  const lastLeft = left[left.length - 1];
  if (right.length > 0 && lastRight && lastRight.includes('.')) {
    const v4 = right.pop()!;
    const octets = v4.split('.').map(Number);
    const [o0, o1, o2, o3] = octets;
    if (octets.length !== 4 || o0 === undefined || o1 === undefined || o2 === undefined || o3 === undefined || octets.some(o => isNaN(o) || o < 0 || o > 255)) return null;
    ipv4Hextets = [(o0 << 8) | o1, (o2 << 8) | o3];
  } else if (parts.length === 1 && left.length > 0 && lastLeft && lastLeft.includes('.')) {
    const v4 = left.pop()!;
    const octets = v4.split('.').map(Number);
    const [o0, o1, o2, o3] = octets;
    if (octets.length !== 4 || o0 === undefined || o1 === undefined || o2 === undefined || o3 === undefined || octets.some(o => isNaN(o) || o < 0 || o > 255)) return null;
    ipv4Hextets = [(o0 << 8) | o1, (o2 << 8) | o3];
  }

  const totalGiven = left.length + right.length + ipv4Hextets.length;
  if (parts.length === 1) {
    if (totalGiven !== 8) return null;
  } else {
    if (totalGiven >= 8) return null;
  }

  const zeros = new Array(8 - totalGiven).fill('0');
  const allHextetStrings = [...left, ...zeros, ...right];
  const all = allHextetStrings.map(s => parseInt(s, 16));
  all.push(...ipv4Hextets);
  if (all.some(n => isNaN(n) || n < 0 || n > 0xffff)) return null;
  return all;
}

export function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(p => {
    if (!/^\d+$/.test(p)) return -1;
    if (p.length > 1 && p.startsWith('0')) return -1;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });
  if (octets.some(o => o === -1)) return false;
  const [o0, o1, o2] = octets;
  if (o0 === undefined || o1 === undefined || o2 === undefined) return false;
  if (o0 === 0) return false; // 0.0.0.0/8
  if (o0 === 10) return false; // 10.0.0.0/8
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return false; // 100.64.0.0/10 CGNAT
  if (o0 === 127) return false; // 127.0.0.0/8 Loopback
  if (o0 === 169 && o1 === 254) return false; // 169.254.0.0/16 Link-local / metadata
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return false; // 172.16.0.0/12
  if (o0 === 192 && o1 === 0 && o2 === 0) return false; // 192.0.0.0/24
  if (o0 === 192 && o1 === 0 && o2 === 2) return false; // 192.0.2.0/24 TEST-NET-1
  if (o0 === 192 && o1 === 88 && o2 === 99) return false; // 192.88.99.0/24
  if (o0 === 192 && o1 === 168) return false; // 192.168.0.0/16
  if (o0 === 198 && (o1 === 18 || o1 === 19)) return false; // 198.18.0.0/15
  if (o0 === 198 && o1 === 51 && o2 === 100) return false; // 198.51.100.0/24 TEST-NET-2
  if (o0 === 203 && o1 === 0 && o2 === 113) return false; // 203.0.113.0/24 TEST-NET-3
  if (o0 >= 224) return false; // 224.0.0.0/4 Multicast and reserved
  return true;
}

export function isPublicIpv6(ip: string): boolean {
  const h = parseIpv6Hextets(ip);
  if (!h) return false;
  // Unspecified :: or loopback ::1
  if (h.every((x, i) => (i === 7 ? x === 1 : x === 0))) return false;
  if (h.every(x => x === 0)) return false;

  // IPv4-mapped ::ffff:0:0/96
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  if (
    h0 === undefined || h1 === undefined || h2 === undefined || h3 === undefined ||
    h4 === undefined || h5 === undefined || h6 === undefined || h7 === undefined
  ) {
    return false;
  }

  // IPv4-mapped ::ffff:0:0/96
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    const o0 = (h6 >> 8) & 0xff;
    const o1 = h6 & 0xff;
    const o2 = (h7 >> 8) & 0xff;
    const o3 = h7 & 0xff;
    return isPublicIpv4(`${o0}.${o1}.${o2}.${o3}`);
  }

  // Unique Local Address fc00::/7
  if ((h0 & 0xfe00) === 0xfc00) return false;
  // Link-Local fe80::/10
  if ((h0 & 0xffc0) === 0xfe80) return false;
  // Multicast ff00::/8
  if ((h0 & 0xff00) === 0xff00) return false;
  // Discard 100::/64
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return false;
  // Documentation 2001:db8::/32
  if (h0 === 0x2001 && h1 === 0x0db8) return false;
  // Benchmarking 2001:2::/48
  if (h0 === 0x2001 && h1 === 0x0002) return false;
  // Orchidv2 2001:20::/28
  if (h0 === 0x2001 && (h1 & 0xfff0) === 0x0020) return false;
  // Teredo 2001:0000::/32
  if (h0 === 0x2001 && h1 === 0) return false;
  // 6to4 2002::/16
  if (h0 === 0x2002) return false;
  // RFC 6052 DNS64 may synthesize these alongside A records. Validate the embedded IPv4,
  // including metadata/private exclusions, rather than rejecting an otherwise public site.
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isPublicIpv4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`);
  }
  return (h0 & 0xe000) === 0x2000;
}

export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPublicIpv4(ip);
  if (net.isIPv6(ip)) return isPublicIpv6(ip);
  return false;
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<Array<{ address: string; family: number }>>;

export async function resolvePublicDestination(
  host: string,
  lookupFn: DnsLookupFn = dns.promises.lookup as unknown as DnsLookupFn
): Promise<string> {
  if (!host || typeof host !== 'string') {
    throw new Error('EGRESS_TARGET_INVALID: Host must be a non-empty string');
  }

  // Reject zone identifiers
  if (host.includes('%')) {
    throw new Error('EGRESS_TARGET_FORBIDDEN: Zone identifiers are not permitted');
  }

  const lower = host.toLowerCase().trim();

  // Reject localhost and forbidden domains
  if (lower === 'localhost' || FORBIDDEN_TLDS.some(tld => lower.endsWith(tld))) {
    throw new Error('EGRESS_TARGET_FORBIDDEN: Local and internal domain names are forbidden');
  }

  // If host is already an IP address
  if (net.isIP(lower)) {
    if (!isPublicIp(lower)) {
      throw new Error('EGRESS_TARGET_FORBIDDEN: Target IP is not a permitted public address');
    }
    return lower;
  }

  // Reject ambiguous numeric hostnames like 127.1, 0177.0.0.1, or 2130706433
  if (/^[\d.]+$/.test(lower) || /^0x[0-9a-f]+$/i.test(lower)) {
    throw new Error('EGRESS_TARGET_FORBIDDEN: Ambiguous or non-canonical numeric host');
  }

  // Validate hostname format
  if (lower.length > 253) {
    throw new Error('EGRESS_TARGET_INVALID: Hostname exceeds maximum length of 253 characters');
  }

  const labels = lower.split('.');
  if (labels.length < 2 || labels.some(label => !label || label.length > 63)) {
    throw new Error('EGRESS_TARGET_INVALID: Hostname must contain valid labels');
  }

  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error(`EGRESS_TARGET_INVALID: Invalid hostname label "${label}"`);
    }
  }

  // Resolve DNS
  const records = await lookupFn(lower, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new Error('EGRESS_DNS_RESOLUTION_FAILED: No IP addresses resolved');
  }

  // CRITICAL: If ANY address resolved is non-public, fail closed!
  for (const record of records) {
    if (!isPublicIp(record.address)) {
      throw new Error(`EGRESS_TARGET_FORBIDDEN: Domain resolved to non-public IP ${record.address}`);
    }
  }

  const first = records.find(record => record.family === 4) ?? records[0];
  if (!first) {
    throw new Error('EGRESS_DNS_RESOLUTION_FAILED: No IP addresses resolved');
  }
  return first.address;
}

export interface HostedEgressProxyOptions {
  port?: number;
  username?: string;
  password?: string;
  maxTunnels?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  lookupFn?: DnsLookupFn;
}

export interface HostedEgressProxy {
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly activeTunnels: number;
  close(): Promise<void>;
}

export async function openHostedEgressProxy(
  options: HostedEgressProxyOptions = {}
): Promise<HostedEgressProxy> {
  const username = options.username ?? 'automate-egress';
  const password = options.password ?? crypto.randomBytes(24).toString('base64url');
  const expectedAuthHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const expectedAuthBuffer = Buffer.from(expectedAuthHeader);

  const maxTunnels = options.maxTunnels ?? 128;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;

  const activeSockets = new Set<net.Socket>();
  let isClosing = false;

  const server = http.createServer((_req, res) => {
    // Only HTTP CONNECT is supported by this egress proxy
    res.writeHead(405, { 'Content-Type': 'text/plain', 'Connection': 'close' });
    res.end('Method Not Allowed');
  });

  server.on('connection', socket => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  server.on('connect', async (req, clientSocket, head) => {
    if (isClosing) {
      clientSocket.destroy();
      return;
    }

    // Authenticate proxy client
    const authHeader = req.headers['proxy-authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="automate-egress"\r\n' +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n\r\n'
      );
      clientSocket.destroy();
      return;
    }

    const authBuffer = Buffer.from(authHeader);
    if (
      authBuffer.length !== expectedAuthBuffer.length ||
      !crypto.timingSafeEqual(authBuffer, expectedAuthBuffer)
    ) {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="automate-egress"\r\n' +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n\r\n'
      );
      clientSocket.destroy();
      return;
    }

    // Method check
    if (req.method !== 'CONNECT') {
      clientSocket.write('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Parse target authority
    const url = req.url ?? '';
    let host: string;
    let port: number;

    if (url.startsWith('[')) {
      const closeBracket = url.indexOf(']');
      if (closeBracket === -1) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      host = url.slice(1, closeBracket);
      const colon = url.indexOf(':', closeBracket);
      if (colon === -1) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      port = parseInt(url.slice(colon + 1), 10);
    } else {
      const colon = url.lastIndexOf(':');
      if (colon === -1) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      host = url.slice(0, colon);
      port = parseInt(url.slice(colon + 1), 10);
    }

    // Enforce port 443 ONLY
    if (port !== 443 || isNaN(port)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Enforce tunnel limit
    if (activeSockets.size > maxTunnels) {
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Validate and resolve to public IP
    let targetIp: string;
    try {
      targetIp = await resolvePublicDestination(host, options.lookupFn);
    } catch {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    if (isClosing || clientSocket.destroyed) return;

    // Connect directly to the chosen public IP to prevent DNS rebinding
    const upstream = net.connect({
      host: targetIp,
      port: 443,
      timeout: connectTimeoutMs,
    });

    activeSockets.add(upstream);
    upstream.on('close', () => activeSockets.delete(upstream));

    let connected = false;

    upstream.on('connect', () => {
      connected = true;
      upstream.setTimeout(idleTimeoutMs);
      if ('setTimeout' in clientSocket && typeof (clientSocket as net.Socket).setTimeout === 'function') {
        (clientSocket as net.Socket).setTimeout(idleTimeoutMs);
      }

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        upstream.write(head);
      }
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on('timeout', () => {
      upstream.destroy();
      clientSocket.destroy();
    });

    upstream.on('error', () => {
      if (!connected) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
      clientSocket.destroy();
    });

    clientSocket.on('timeout', () => {
      clientSocket.destroy();
      upstream.destroy();
    });

    clientSocket.on('error', () => {
      upstream.destroy();
    });
    clientSocket.once('close', () => {
      upstream.destroy();
    });
  });

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  server.once('error', reject);
  await promise;

  const boundAddress = server.address() as net.AddressInfo;
  const boundPort = boundAddress.port;

  return {
    port: boundPort,
    username,
    password,
    get activeTunnels() {
      return Math.floor(activeSockets.size / 2);
    },
    async close() {
      if (isClosing) return;
      isClosing = true;
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      const { promise: closePromise, resolve: closeResolve } = Promise.withResolvers<void>();
      server.close(() => closeResolve());
      await closePromise;
    },
  };
}
