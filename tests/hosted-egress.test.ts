import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import net from 'node:net';
import tls from 'node:tls';
import {
  isPublicIp,
  isPublicIpv4,
  isPublicIpv6,
  resolvePublicDestination,
  openHostedEgressProxy,
  HOSTED_CHROMIUM_ARGS,
  type DnsLookupFn,
  type HostedEgressProxy,
} from '../src/hosted-egress';

describe('hosted-egress IP and destination security', () => {
  test('correctly classifies IPv4 public vs private, loopback, CGNAT, link-local, and reserved ranges', () => {
    // Public IPv4
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
    expect(isPublicIp('93.184.216.34')).toBe(true);
    expect(isPublicIp('172.32.0.1')).toBe(true);
    expect(isPublicIp('100.128.0.1')).toBe(true);

    // Loopback
    expect(isPublicIp('127.0.0.1')).toBe(false);
    expect(isPublicIp('127.0.0.2')).toBe(false);
    expect(isPublicIp('127.255.255.255')).toBe(false);

    // Private RFC 1918
    expect(isPublicIp('10.0.0.1')).toBe(false);
    expect(isPublicIp('10.255.255.255')).toBe(false);
    expect(isPublicIp('172.16.0.1')).toBe(false);
    expect(isPublicIp('172.31.255.255')).toBe(false);
    expect(isPublicIp('192.168.0.1')).toBe(false);
    expect(isPublicIp('192.168.1.100')).toBe(false);

    // Carrier-Grade NAT (CGNAT) RFC 6598 (includes Alibaba metadata 100.100.100.200)
    expect(isPublicIp('100.64.0.1')).toBe(false);
    expect(isPublicIp('100.100.100.200')).toBe(false);
    expect(isPublicIp('100.127.255.255')).toBe(false);

    // Link-local & Cloud metadata (AWS, Azure, GCP, Oracle 169.254.169.254)
    expect(isPublicIp('169.254.0.1')).toBe(false);
    expect(isPublicIp('169.254.169.254')).toBe(false);
    expect(isPublicIp('169.254.255.255')).toBe(false);

    // Reserved / Broadcast / Multicast
    expect(isPublicIp('0.0.0.0')).toBe(false);
    expect(isPublicIp('192.0.2.1')).toBe(false); // TEST-NET-1
    expect(isPublicIp('198.51.100.1')).toBe(false); // TEST-NET-2
    expect(isPublicIp('203.0.113.1')).toBe(false); // TEST-NET-3
    expect(isPublicIp('224.0.0.1')).toBe(false); // Multicast
    expect(isPublicIp('240.0.0.1')).toBe(false); // Reserved Class E
    expect(isPublicIp('255.255.255.255')).toBe(false); // Broadcast
  });

  test('correctly classifies IPv6 public vs loopback, link-local, ULA, and metadata ranges', () => {
    // Public IPv6
    expect(isPublicIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
    expect(isPublicIp('2001:4860:4860::8888')).toBe(true);

    // Loopback and unspecified
    expect(isPublicIp('::1')).toBe(false);
    expect(isPublicIp('::')).toBe(false);

    // Link-local
    expect(isPublicIp('fe80::1')).toBe(false);
    expect(isPublicIp('fe80::dead:beef')).toBe(false);

    // Unique Local Address (ULA) (includes AWS metadata fd00:ec2::254)
    expect(isPublicIp('fc00::1')).toBe(false);
    expect(isPublicIp('fd00:ec2::254')).toBe(false);
    expect(isPublicIp('fd12:3456:789a::1')).toBe(false);

    // Multicast
    expect(isPublicIp('ff02::1')).toBe(false);

    // Documentation & benchmarking
    expect(isPublicIp('2001:db8::1')).toBe(false);
    expect(isPublicIp('2001:2::1')).toBe(false);

    // IPv4-mapped IPv6
    expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicIp('::ffff:169.254.169.254')).toBe(false);
    expect(isPublicIp('::ffff:192.168.1.1')).toBe(false);
  });

  test('DNS64 public translations work without permitting translated internal addresses', async () => {
    expect(isPublicIp('64:ff9b::df8:a240')).toBe(true);
    expect(isPublicIp('64:ff9b::a9fe:a9fe')).toBe(false);
    expect(isPublicIp('64:ff9b::a00:1')).toBe(false);
    expect(isPublicIp('64:ff9b:1::a00:1')).toBe(false);
    expect(isPublicIp('fec0::1')).toBe(false);
    expect(isPublicIp('::2')).toBe(false);
    const dns64: DnsLookupFn = async () => [{ address: '64:ff9b::df8:a240', family: 6 }, { address: '13.248.162.64', family: 4 }];
    expect(await resolvePublicDestination('public.example.com', dns64)).toBe('13.248.162.64');
  });

  test('refuses invalid hosts, zone identifiers, localhost, and non-canonical numeric hosts', async () => {
    // Zone identifiers
    await expect(resolvePublicDestination('example.com%eth0')).rejects.toThrow('Zone identifiers are not permitted');
    await expect(resolvePublicDestination('fe80::1%1')).rejects.toThrow('Zone identifiers are not permitted');

    // Localhost and internal TLDs
    await expect(resolvePublicDestination('localhost')).rejects.toThrow('Local and internal domain names are forbidden');
    await expect(resolvePublicDestination('myhost.local')).rejects.toThrow('Local and internal domain names are forbidden');
    await expect(resolvePublicDestination('internal.corp')).rejects.toThrow('Local and internal domain names are forbidden');
    await expect(resolvePublicDestination('test.example')).rejects.toThrow('Local and internal domain names are forbidden');
    await expect(resolvePublicDestination('service.invalid')).rejects.toThrow('Local and internal domain names are forbidden');

    // Ambiguous numeric hostnames
    await expect(resolvePublicDestination('127.1')).rejects.toThrow('Ambiguous or non-canonical numeric host');
    await expect(resolvePublicDestination('2130706433')).rejects.toThrow('Ambiguous or non-canonical numeric host');
    await expect(resolvePublicDestination('0177.0.0.1')).rejects.toThrow('Ambiguous or non-canonical numeric host');
    await expect(resolvePublicDestination('0x7f000001')).rejects.toThrow('Ambiguous or non-canonical numeric host');

    // Direct private IP literals
    await expect(resolvePublicDestination('127.0.0.1')).rejects.toThrow('Target IP is not a permitted public address');
    await expect(resolvePublicDestination('169.254.169.254')).rejects.toThrow('Target IP is not a permitted public address');
    await expect(resolvePublicDestination('10.0.0.5')).rejects.toThrow('Target IP is not a permitted public address');
  });

  test('prevents DNS rebinding by failing closed when ANY resolved IP is non-public', async () => {
    // Mock lookup that returns both a public IP and a private loopback IP (DNS rebinding attempt)
    const rebindingLookup: DnsLookupFn = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];

    await expect(
      resolvePublicDestination('attacker-rebinding.example.com', rebindingLookup)
    ).rejects.toThrow('Domain resolved to non-public IP 127.0.0.1');

    // Mock lookup that returns cloud metadata
    const metadataLookup: DnsLookupFn = async () => [
      { address: '169.254.169.254', family: 4 },
    ];

    await expect(
      resolvePublicDestination('metadata-leak.example.com', metadataLookup)
    ).rejects.toThrow('Domain resolved to non-public IP 169.254.169.254');

    // Mock lookup that returns purely valid public IPs
    const publicLookup: DnsLookupFn = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ];

    const resolved = await resolvePublicDestination('valid-site.example.com', publicLookup);
    expect(resolved).toBe('93.184.216.34');
  });

  test('HOSTED_CHROMIUM_ARGS contains anti-bypass security switches', () => {
    expect(HOSTED_CHROMIUM_ARGS).toContain('--proxy-bypass-list=<-loopback>');
    expect(HOSTED_CHROMIUM_ARGS).toContain('--disable-quic');
    expect(HOSTED_CHROMIUM_ARGS).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  });
});

describe('openHostedEgressProxy HTTP CONNECT server', () => {
  let proxy: HostedEgressProxy;

  beforeAll(async () => {
    proxy = await openHostedEgressProxy({
      username: 'test-proxy-user',
      password: 'test-proxy-password-321',
    });
  });

  afterAll(async () => {
    await proxy.close();
  });

  function sendRaw(
    data: string,
    onData: (chunk: string, socket: net.Socket) => void
  ): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write(data);
    });
    socket.setEncoding('utf-8');
    socket.on('data', chunk => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      onData(text, socket);
    });
    socket.on('close', () => resolve());
    socket.on('error', err => reject(err));
    return promise;
  }

  test('requires proxy authentication (returns 407 on missing or invalid credentials)', async () => {
    let responseText = '';
    await sendRaw(
      'CONNECT 93.184.216.34:443 HTTP/1.1\r\nHost: 93.184.216.34:443\r\n\r\n',
      (chunk, socket) => {
        responseText += chunk;
        socket.end();
      }
    );
    expect(responseText).toContain('407 Proxy Authentication Required');
    expect(responseText).toContain('Proxy-Authenticate: Basic realm="automate-egress"');

    // Invalid credentials
    let invalidAuthResponse = '';
    await sendRaw(
      'CONNECT 93.184.216.34:443 HTTP/1.1\r\n' +
      'Host: 93.184.216.34:443\r\n' +
      'Proxy-Authorization: Basic d3Jvbmc6Y3JlZHM=\r\n\r\n',
      (chunk, socket) => {
        invalidAuthResponse += chunk;
        socket.end();
      }
    );
    expect(invalidAuthResponse).toContain('407 Proxy Authentication Required');
  });

  test('rejects non-CONNECT HTTP methods with 405', async () => {
    const auth = Buffer.from('test-proxy-user:test-proxy-password-321').toString('base64');
    let responseText = '';
    await sendRaw(
      `GET http://93.184.216.34/ HTTP/1.1\r\nHost: 93.184.216.34\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      (chunk, socket) => {
        responseText += chunk;
        socket.end();
      }
    );
    // CONNECT proxy only
    expect(responseText).toMatch(/405 Method Not Allowed/);
  });

  test('rejects non-443 ports with 403 Forbidden', async () => {
    const auth = Buffer.from('test-proxy-user:test-proxy-password-321').toString('base64');

    let responsePort80 = '';
    await sendRaw(
      `CONNECT 93.184.216.34:80 HTTP/1.1\r\nHost: 93.184.216.34:80\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      (chunk, socket) => {
        responsePort80 += chunk;
        socket.end();
      }
    );
    expect(responsePort80).toContain('403 Forbidden');

    let responsePort8080 = '';
    await sendRaw(
      `CONNECT 93.184.216.34:8080 HTTP/1.1\r\nHost: 93.184.216.34:8080\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      (chunk, socket) => {
        responsePort8080 += chunk;
        socket.end();
      }
    );
    expect(responsePort8080).toContain('403 Forbidden');
  });

  test('rejects loopback, private, and cloud metadata targets with 403 Forbidden', async () => {
    const auth = Buffer.from('test-proxy-user:test-proxy-password-321').toString('base64');

    for (const target of ['127.0.0.1:443', 'localhost:443', '169.254.169.254:443', '10.0.0.1:443']) {
      let response = '';
      await sendRaw(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
        (chunk, socket) => {
          response += chunk;
          socket.end();
        }
      );
      expect(response).toContain('403 Forbidden');
    }
  });

  test('rejects DNS resolution to private/loopback IP with 403 Forbidden', async () => {
    const customLookup: DnsLookupFn = async () => [
      { address: '127.0.0.1', family: 4 },
    ];
    const proxyWithCustomDns = await openHostedEgressProxy({
      username: 'u',
      password: 'p',
      lookupFn: customLookup,
    });

    try {
      const auth = Buffer.from('u:p').toString('base64');
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const socket = net.connect(proxyWithCustomDns.port, '127.0.0.1', () => {
        socket.write(`CONNECT private.example.test:443 HTTP/1.1\r\nHost: private.example.test:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      });
      let response = '';
      socket.setEncoding('utf-8');
      socket.on('data', chunk => {
        response += chunk;
        socket.end();
      });
      socket.on('close', () => resolve());
      socket.on('error', reject);
      await promise;

      expect(response).toContain('403 Forbidden');
    } finally {
      await proxyWithCustomDns.close();
    }
  });
});
