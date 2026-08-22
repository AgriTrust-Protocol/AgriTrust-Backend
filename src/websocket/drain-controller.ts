/**
 * AgriTrust Backend – WebSocket Drain Controller
 *
 * Implements a three-state FSM (Active → Draining → Closed) for each
 * WebSocket connection.  The controller enforces:
 *
 *   • 120 s quiescence → drain trigger
 *   • 30 s grace window for flushing pending frames
 *   • 500 ms drain-ACK deadline before RST-close
 *   • Atomic compare-and-swap on the state map to prevent double-drain
 *   • Thundering-herd guard (≤ 0.1 % connections draining at once)
 */

import { EventEmitter } from 'events';
import {
  DRAIN_GRACE_WINDOW_S,
  DRAIN_ACK_TIMEOUT_MS,
  MAX_DRAINING_RATIO,
  MAX_PENDING_FRAMES,
  GOAWAY_OPCODE,
  BACKPRESSURE_429_OPCODE,
} from '../config/websocket';

// ─── Types ──────────────────────────────────────────────────────────────────

export enum ConnectionState {
  Active = 'Active',
  Draining = 'Draining',
  Closed = 'Closed',
}

export interface DrainEntry {
  state: ConnectionState;
  drainStartedAt: number;
  pendingFrames: number;
  ackReceived: boolean;
}

export type DrainReason = 'quiescence' | 'backpressure' | 'manual';

export interface SocketHandle {
  id: string;
  send(data: Buffer): void;
  close(): void;
  destroy(): void;
}

// ─── DrainController ────────────────────────────────────────────────────────

export class DrainController extends EventEmitter {
  private readonly states: Map<string, DrainEntry> = new Map();
  private graceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private ackTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private totalActive = 0;

  // ── State queries ───────────────────────────────────────────────────────

  getState(socketId: string): ConnectionState | undefined {
    return this.states.get(socketId)?.state;
  }

  getDrainEntry(socketId: string): DrainEntry | undefined {
    return this.states.get(socketId);
  }

  getDrainingCount(): number {
    let count = 0;
    for (const entry of this.states.values()) {
      if (entry.state === ConnectionState.Draining) count++;
    }
    return count;
  }

  getActiveCount(): number {
    return this.totalActive;
  }

  // ── Lifecycle transitions ─────────────────────────────────────────────

  /** Register a new Active connection. */
  register(socketId: string): void {
    this.states.set(socketId, {
      state: ConnectionState.Active,
      drainStartedAt: 0,
      pendingFrames: 0,
      ackReceived: false,
    });
    this.totalActive++;
  }

  /** Record an inbound frame (resets quiescence and tracks pending count). */
  recordFrame(socketId: string): void {
    const entry = this.states.get(socketId);
    if (!entry || entry.state !== ConnectionState.Active) return;
    entry.pendingFrames++;
  }

  /** Acknowledge that a pending frame has been consumed / sent. */
  ackFrame(socketId: string): void {
    const entry = this.states.get(socketId);
    if (!entry) return;
    if (entry.pendingFrames > 0) entry.pendingFrames--;
  }

  /** Update the pending frame count directly. */
  setPendingFrames(socketId: string, count: number): void {
    const entry = this.states.get(socketId);
    if (!entry) return;
    entry.pendingFrames = count;
  }

  /**
   * Attempt to transition Active → Draining (CAS).
   * Returns `true` if the transition occurred.
   */
  initiateDrain(socketId: string, handle: SocketHandle, reason: DrainReason): boolean {
    const entry = this.states.get(socketId);
    if (!entry) return false;

    // CAS: only transition from Active
    if (entry.state !== ConnectionState.Active) return false;

    // Thundering-herd guard
    if (!this.canDrain()) {
      this.emit('drain_deferred', socketId, reason);
      return false;
    }

    entry.state = ConnectionState.Draining;
    entry.drainStartedAt = Date.now();
    this.totalActive--;

    // Send GOAWAY or 429 depending on reason
    const opcode = reason === 'backpressure' ? BACKPRESSURE_429_OPCODE : GOAWAY_OPCODE;
    const frame = Buffer.alloc(1);
    frame[0] = opcode;
    try {
      handle.send(frame);
    } catch {
      // socket may already be half-closed
    }

    this.emit('drain_started', socketId, reason);

    // Grace window timer
    const graceTimer = setTimeout(() => {
      this.graceTimers.delete(socketId);
      this.startAckDeadline(socketId, handle);
    }, DRAIN_GRACE_WINDOW_S * 1000);
    graceTimer.unref();
    this.graceTimers.set(socketId, graceTimer);

    return true;
  }

  /** Client acknowledged the drain — close cleanly. */
  acknowledgeDrain(socketId: string, handle: SocketHandle): void {
    const entry = this.states.get(socketId);
    if (!entry || entry.state !== ConnectionState.Draining) return;

    entry.ackReceived = true;
    this.clearTimers(socketId);
    this.transitionClosed(socketId, handle, false);
  }

  /**
   * Check whether a connection's pending frames exceed the backpressure
   * threshold and trigger immediate drain if so.
   */
  checkBackpressure(socketId: string, handle: SocketHandle): boolean {
    const entry = this.states.get(socketId);
    if (!entry || entry.state !== ConnectionState.Active) return false;
    if (entry.pendingFrames > MAX_PENDING_FRAMES) {
      return this.initiateDrain(socketId, handle, 'backpressure');
    }
    return false;
  }

  /** Force-close (RST) a connection regardless of current state. */
  forceClose(socketId: string, handle: SocketHandle): void {
    this.clearTimers(socketId);
    this.transitionClosed(socketId, handle, true);
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private canDrain(): boolean {
    const total = this.totalActive + this.getDrainingCount();
    if (total === 0) return true;
    return this.getDrainingCount() / total < MAX_DRAINING_RATIO;
  }

  private startAckDeadline(socketId: string, handle: SocketHandle): void {
    const entry = this.states.get(socketId);
    if (!entry || entry.state !== ConnectionState.Draining) return;

    if (entry.ackReceived) {
      this.transitionClosed(socketId, handle, false);
      return;
    }

    const ackTimer = setTimeout(() => {
      this.ackTimers.delete(socketId);
      this.transitionClosed(socketId, handle, true);
    }, DRAIN_ACK_TIMEOUT_MS);
    ackTimer.unref();
    this.ackTimers.set(socketId, ackTimer);
  }

  private transitionClosed(socketId: string, handle: SocketHandle, rst: boolean): void {
    const entry = this.states.get(socketId);
    if (!entry) return;

    const wasDraining = entry.state === ConnectionState.Draining;
    const wasActive = entry.state === ConnectionState.Active;

    entry.state = ConnectionState.Closed;
    this.clearTimers(socketId);

    if (wasActive) this.totalActive--;

    const durationMs = wasDraining ? Date.now() - entry.drainStartedAt : 0;

    try {
      if (rst) {
        handle.destroy();
      } else {
        handle.close();
      }
    } catch {
      // already closed
    }

    this.emit('connection_closed', socketId, { rst, durationMs });
  }

  private clearTimers(socketId: string): void {
    const g = this.graceTimers.get(socketId);
    if (g) {
      clearTimeout(g);
      this.graceTimers.delete(socketId);
    }
    const a = this.ackTimers.get(socketId);
    if (a) {
      clearTimeout(a);
      this.ackTimers.delete(socketId);
    }
  }

  /** Remove a closed entry from the state map (called after ring-buffer recording). */
  purge(socketId: string): void {
    this.clearTimers(socketId);
    const entry = this.states.get(socketId);
    if (entry && entry.state === ConnectionState.Active) {
      this.totalActive--;
    }
    this.states.delete(socketId);
  }

  /** Reset all state (for testing). */
  reset(): void {
    for (const id of this.graceTimers.keys()) this.clearTimers(id);
    for (const id of this.ackTimers.keys()) this.clearTimers(id);
    this.states.clear();
    this.graceTimers.clear();
    this.ackTimers.clear();
    this.totalActive = 0;
  }
}
