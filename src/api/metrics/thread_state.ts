/**
 * AgriTrust Backend - Thread-State Metrics
 *
 * Parses /proc/self/status (Linux) and /proc/self/task/[tid]/status to
 * collect per-thread state, mapping each thread to one of:
 *   Running, Sleeping (S), Disk Sleep (D), Zombie (Z), Deadlocked
 *
 * Exposes a Prometheus GaugeVec `node_thread_state` with labels:
 *   - thread_name  (thread ID or name)
 *   - thread_state (Running | Sleeping | DiskSleep | Zombie | Deadlocked)
 *
 * On non-Linux platforms, falls back to a single "Running" thread for the
 * main process (Node.js does not expose per-thread /proc data on other OSes).
 *
 * Collection runs on the same 15-second interval as other runtime metrics.
 */

import * as fs from 'fs';
import * as os from 'os';
import { Gauge } from 'prom-client';
import { metricsRegistry } from './registry';

// ─── Prometheus GaugeVec ────────────────────────────────────────────────────

export const threadStateGauge = new Gauge({
  name: 'node_thread_state',
  help: 'Thread state (Running, Sleeping, DiskSleep, Zombie, Deadlocked) per thread',
  labelNames: ['thread_name', 'thread_state'],
  registers: [metricsRegistry],
});

// ─── /proc/self/task parsing (Linux only) ───────────────────────────────────

const STATE_MAP: Record<string, string> = {
  R: 'Running',
  S: 'Sleeping',
  D: 'DiskSleep',
  Z: 'Zombie',
  T: 'Sleeping', // Stopped - treat as sleeping for alerting purposes
  t: 'Sleeping', // Tracing stop
  X: 'Deadlocked', // Dead
  x: 'Deadlocked', // Dead
  K: 'Deadlocked', // Wakekill
  W: 'Sleeping', // Waking
  P: 'DiskSleep', // Parked
  I: 'Sleeping', // Idle (kernel threads)
};

/**
 * Parse a single /proc/self/task/[tid]/status file.
 * Returns the mapping of thread_name -> state category.
 */
function parseTaskStatus(content: string, tid: string): Record<string, string> {
  const nameLine = content.split('\n').find((l) => l.startsWith('Name:'));
  const threadName = nameLine ? nameLine.replace('Name:\t', '').trim() : `thread-${tid}`;

  // Find the "State:" line
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('State:')) {
      // Format: "State:  S (sleeping)"
      const raw = line.replace('State:\t', '').trim();
      const code = raw.charAt(0);
      const stateName = STATE_MAP[code] ?? 'Running';
      return { [threadName]: stateName };
    }
  }
  return { [threadName]: 'Running' };
}

/**
 * Read /proc/self/task/ directory to enumerate thread IDs, then parse each
 * task's status file for state information.
 *
 * Returns a map of thread_name -> state_category.
 */
function collectProcThreadStates(): Map<string, string> {
  const result = new Map<string, string>();

  try {
    const taskDir = '/proc/self/task';
    const tids = fs.readdirSync(taskDir);

    for (const tid of tids) {
      const statusPath = `${taskDir}/${tid}/status`;
      try {
        const content = fs.readFileSync(statusPath, 'utf-8');
        const parsed = parseTaskStatus(content, tid);
        for (const [name, state] of Object.entries(parsed)) {
          result.set(name, state);
        }
      } catch {
        // Thread may have exited between readdir and read - skip it
      }
    }
  } catch {
    // Not Linux or /proc not available - fall through to fallback
  }

  return result;
}

// ─── Fallback for non-Linux platforms ───────────────────────────────────────

function fallbackThreadStates(): Map<string, string> {
  const result = new Map<string, string>();
  result.set(os.hostname(), 'Running');
  return result;
}

// ─── Public collection function ─────────────────────────────────────────────

/**
 * Collect thread states and update the Prometheus gauge.
 * Called by the main runtime-metrics collection loop.
 */
export function collectThreadStates(): void {
  const threadStates =
    process.platform === 'linux' ? collectProcThreadStates() : fallbackThreadStates();

  // Reset before setting to prevent stale label combinations from accumulating
  threadStateGauge.reset();

  for (const [threadName, state] of threadStates) {
    threadStateGauge.set({ thread_name: threadName, thread_state: state }, 1);
  }
}
