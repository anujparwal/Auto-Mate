import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openHostedServer, type HostedServerInstance } from '../src/hosted-server';
import { openHostedTunnel, type HostedTunnelInstance } from '../src/hosted-tunnel';

export interface ParsedHostedOptions {
  readonly host?: string;
  readonly publicOrigin?: string;
  readonly port?: number;
  readonly dataDirectory: string;
  readonly registrationKey: string;
  readonly isKeySupplied: boolean;
}

/**
 * Resolves hosted options from environment variables.
 * Command-line arguments must be empty; configuration is via environment variables.
 */
export function resolveHostedOptions(args: readonly string[] = []): ParsedHostedOptions {
  if (args.length > 0) {
    throw new Error('INVALID_HOSTED_ARGUMENT: Hosted mode accepts no command-line arguments. Configure via environment variables.');
  }

  const rawOrigin = process.env.AUTOMATE_HOSTED_PUBLIC_ORIGIN?.trim() ||
    (process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}` : undefined) ||
    (process.env.RAILWAY_STATIC_URL?.trim() ? `https://${process.env.RAILWAY_STATIC_URL.trim()}` : undefined) ||
    (process.env.RENDER_EXTERNAL_URL?.trim() ? process.env.RENDER_EXTERNAL_URL.trim() : undefined) ||
    (process.env.SPACE_HOST?.trim() ? `https://${process.env.SPACE_HOST.trim()}` : undefined);
  const publicOrigin = rawOrigin && rawOrigin.length > 0 ? rawOrigin : undefined;

  let port: number | undefined;
  const rawPort = process.env.PORT?.trim() || process.env.AUTOMATE_HOSTED_PORT?.trim();
  if (rawPort && rawPort.length > 0) {
    const envPort = parseInt(rawPort, 10);
    if (isNaN(envPort) || envPort < 0 || envPort > 65535) {
      throw new Error(`Invalid PORT environment variable: ${rawPort}`);
    }
    port = envPort;
  }

  const host = process.env.HOST?.trim() || (process.env.PORT ? '0.0.0.0' : undefined);

  let defaultDataDir: string;
  if (process.env.AUTOMATE_HOSTED_DATA_DIR?.trim()) {
    defaultDataDir = process.env.AUTOMATE_HOSTED_DATA_DIR.trim();
  } else if (process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim()) {
    defaultDataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH.trim();
  } else if (process.platform === 'win32') {
    defaultDataDir = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'AutoMate', 'hosted')
      : join(homedir(), '.local', 'share', 'AutoMate', 'hosted');
  } else {
    defaultDataDir = '/data';
  }
  const dataDirectory = defaultDataDir;

  const rawKey = process.env.AUTOMATE_HOSTED_REGISTRATION_KEY?.trim();

  let registrationKey: string;
  let isKeySupplied: boolean;

  if (rawKey && rawKey.length > 0) {
    if (rawKey !== 'none' && rawKey.length < 16) {
      throw new Error('INVALID_REGISTRATION_KEY: Registration key must be at least 16 characters long.');
    }
    registrationKey = rawKey === 'none' ? '' : rawKey;
    isKeySupplied = true;
  } else {
    registrationKey = '';
    isKeySupplied = false;
  }

  return {
    host,
    publicOrigin,
    port,
    dataDirectory,
    registrationKey,
    isKeySupplied,
  };
}

/**
 * Runs the Auto-Mate Hosted server with Cloudflare QuickTunnel or preconfigured reverse proxy.
 */
export async function runHosted(args: readonly string[] = []): Promise<void> {
  const options = resolveHostedOptions(args);

  let server: HostedServerInstance | undefined;
  let tunnel: HostedTunnelInstance | undefined;
  let shutdownTriggered = false;

  const { promise: shutdownDone, resolve: resolveShutdown } = Promise.withResolvers<void>();

  async function shutdown(reason: string): Promise<void> {
    if (shutdownTriggered) return;
    shutdownTriggered = true;
    console.log(`\nShutting down Auto-Mate hosted service (${reason})...`);

    try {
      if (tunnel) {
        await tunnel.close().catch((err) => {
          console.error('Error closing tunnel:', err instanceof Error ? err.message : String(err));
        });
      }
    } finally {
      try {
        if (server) {
          await server.close().catch((err) => {
            console.error('Error closing server:', err instanceof Error ? err.message : String(err));
          });
        }
      } finally {
        console.log('Hosted service shutdown complete.');
        resolveShutdown();
      }
    }
  }

  const signalHandler = (sig: string) => {
    shutdown(`signal ${sig}`).catch(() => {});
  };

  process.once('SIGINT', () => signalHandler('SIGINT'));
  process.once('SIGTERM', () => signalHandler('SIGTERM'));

  try {
    // 1. Open the hosted server (with supplied origin or undefined for two-phase bootstrap)
    server = await openHostedServer({
      host: options.host,
      publicOrigin: options.publicOrigin,
      port: options.port,
      dataDirectory: options.dataDirectory,
      registrationKey: options.registrationKey,
    });

    let publicUrl: string;

    if (options.publicOrigin) {
      publicUrl = server.url;
    } else {
      console.log(`Starting Cloudflare QuickTunnel for local server port ${server.port}...`);
      tunnel = await openHostedTunnel({
        localPort: server.port,
      });

      // Activate origin once URL is known
      server.activatePublicOrigin(tunnel.origin);
      publicUrl = tunnel.origin;

      // Fail-closed listener on tunnel termination
      tunnel.closed.then(() => {
        if (!shutdownTriggered) {
          console.warn('\nCloudflare QuickTunnel connection terminated unexpectedly.');
          shutdown('tunnel terminated').catch(() => {});
        }
      });
    }

    // 2. Print operator console banner and security notice
    console.log('\n================================================================================');
    console.log('Auto-Mate Hosted Remote Access');
    console.log('================================================================================');
    console.log(`Public HTTPS Link:   ${publicUrl}`);
    console.log(`Local Bound Port:    ${server.port}`);
    console.log(`Data Directory:      ${options.dataDirectory}`);
    if (options.registrationKey) {
      console.log(`Registration Key:    ${options.registrationKey}`);
    } else {
      console.log('Registration:        Open (No operator code required)');
    }
    console.log('--------------------------------------------------------------------------------');
    console.log('[TRUST & SECURITY NOTICE]');
    console.log('• Invite-Only: Remote users must register using the registration key above.');
    console.log('• Host Operator Trust: The host operator has full authority on this machine.');
    console.log('  Active sessions and autofill actions are visible to the operator while signed in.');
    console.log('  Hosted sessions are NOT zero-knowledge from this host.');
    console.log('• AI Model Privacy: AI models NEVER receive account keys, passwords, or vault secrets.');
    console.log('• Execution Guard: Only remote autofill and explicitly approved clicks will execute.');
    console.log('================================================================================\n');
    console.log('Auto-Mate hosted service is running. Press Ctrl+C to stop.');

    // Wait for shutdown to complete
    await shutdownDone;
  } catch (err) {
    await shutdown('startup failure');
    throw err;
  }
}

if (import.meta.main) {
  runHosted(process.argv.slice(2)).catch((err) => {
    console.error('Fatal error starting hosted service:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
