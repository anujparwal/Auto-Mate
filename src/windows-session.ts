import { resolve } from 'node:path';

export interface SessionProtection {
  assertActive(): void;
  close(): void;
}

/** Independent OS lifecycle gate, not authentication and not a substitute for Windows Hello. */
export class WindowsSessionProtection implements SessionProtection {
  #active = false;
  #lastHeartbeat = 0;
  #closed = false;
  #stop?: () => void;
  #watchdog?: NodeJS.Timeout;
  private constructor(private onInactive: () => void) {}

  static async open(onInactive: () => void): Promise<WindowsSessionProtection> {
    if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
    const guard = new WindowsSessionProtection(onInactive);
    const child = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(import.meta.dir, '../platforms/windows/session-monitor.ps1')], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    guard.#stop = () => { child.kill(); };
    const ready = Promise.withResolvers<void>();
    void (async () => {
      let pending = '';
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (!guard.#closed) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 256) throw new Error('SESSION_UNAVAILABLE');
          let end: number;
          while ((end = pending.indexOf('\n')) !== -1) {
            const state = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
            if (state !== 'active' && state !== 'inactive') throw new Error('SESSION_UNAVAILABLE');
            guard.#lastHeartbeat = performance.now();
            if (state === 'active') guard.#active = true;
            else guard.#invalidate();
            ready.resolve();
          }
        }
      } catch { /* The missing/invalid lifecycle channel always removes authority. */ }
      finally { reader.releaseLock(); guard.#invalidate(); ready.reject(new Error('SESSION_UNAVAILABLE')); }
    })();
    void child.exited.then(() => { guard.#invalidate(); ready.reject(new Error('SESSION_UNAVAILABLE')); });
    guard.#watchdog = setInterval(() => {
      if (performance.now() - guard.#lastHeartbeat > 2000) guard.#invalidate();
    }, 500);
    guard.#watchdog.unref();
    const timer = setTimeout(() => ready.reject(new Error('SESSION_UNAVAILABLE')), 10000);
    try {
      await ready.promise;
      return guard;
    } catch { guard.close(); throw new Error('SESSION_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
  }

  #invalidate(): void {
    const wasActive = this.#active;
    this.#active = false;
    if (wasActive && !this.#closed) { try { this.onInactive(); } catch {} }
  }
  assertActive(): void {
    if (this.#closed || !this.#active || performance.now() - this.#lastHeartbeat > 2000) {
      this.#invalidate();
      throw new Error('SESSION_UNAVAILABLE');
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#active = false;
    clearInterval(this.#watchdog); this.#stop?.();
  }
}
