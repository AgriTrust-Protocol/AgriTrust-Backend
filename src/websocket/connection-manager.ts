/**
 * AgriTrust Backend – WebSocket Connection Manager
 *
 * Active connection registry with lifecycle hooks, background quiescence
 * scanning, and load-balancer health reporting.
 *
 * Responsibilities:
 *   • Maintain a Map<socketId, ManagedConnection> of live connections.
 *   • Track lifecycle events in a bounded RingBuffer (100 000 entries, O(1) eviction).
 *   • Run a background tick (10 s) to detect quiescent connections (>120 s silence).
 *   • Coordinate with DrainController for state transitions.
 *   • Expose a health-check that marks the instance unhealthy when any
 *     connections are in Draining state.
 */

import { EventEmitter } from 'events';
import { QUIESCENCE_TIMEOUT_S, SCAN_TICK_INTERVAL_MS } from '../config/websocket';
import { RingBuffer, LifecycleEntry } from './ring-buffer';
import { DrainController, ConnectionState, SocketHandle } from './drain-controller';
import { TelemetryChannel, FrameHandler } from './telemetry-channel';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ManagedConnection {
  socketId: string;
  handle: SocketHandle;
  channel: TelemetryChannel;
  connectedAt: number;
  lastActivityAt: number;
}

export interface HealthStatus {
  healthy: boolean;
  totalConnections: number;
  drainingConnections: number;
}

// ─── ConnectionManager ──────────────────────────────────────────────────────

export class ConnectionManager extends EventEmitter {
  private readonly connections: Map<string, ManagedConnection> = new Map();
  readonly lifecycleBuffer: RingBuffer<LifecycleEntry>;
  readonly drainController: DrainController;
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(drainController?: DrainController, bufferCapacity?: number) {
    super();
    this.drainController = drainController ?? new DrainController();
    this.lifecycleBuffer = new RingBuffer<LifecycleEntry>(bufferCapacity);

    // Wire drain-controller events to lifecycle recording
    this.drainController.on(
      'connection_closed',
      (socketId: string, info: { rst: boolean; durationMs: number }) => {
        this.recordClose(socketId);
        this.emit('connection_closed', socketId, info);
      },
    );
  }

  // ── Connection Lifecycle ──────────────────────────────────────────────

  /** Register a new WebSocket connection. */
  addConnection(
    socketId: string,
    handle: SocketHandle,
    frameHandler?: FrameHandler,
  ): TelemetryChannel {
    const now = Date.now();
    this.drainController.register(socketId);

    const channel = new TelemetryChannel(socketId, handle, this.drainController);
    if (frameHandler) channel.onFrame(frameHandler);

    const managed: ManagedConnection = {
      socketId,
      handle,
      channel,
      connectedAt: now,
      lastActivityAt: now,
    };
    this.connections.set(socketId, managed);

    this.lifecycleBuffer.push({
      socketId,
      connectedAt: now,
      lastActivityAt: now,
      closedAt: 0,
    });

    this.emit('connection_added', socketId);
    return channel;
  }

  /** Update last-activity timestamp (call on every inbound frame). */
  touchConnection(socketId: string): void {
    const conn = this.connections.get(socketId);
    if (conn) conn.lastActivityAt = Date.now();
  }

  /** Remove a connection entry after close. */
  removeConnection(socketId: string): void {
    this.drainController.purge(socketId);
    this.connections.delete(socketId);
  }

  getConnection(socketId: string): ManagedConnection | undefined {
    return this.connections.get(socketId);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  // ── Background Quiescence Scanner ─────────────────────────────────────

  startScanning(intervalMs: number = SCAN_TICK_INTERVAL_MS): void {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => this.scanQuiescent(), intervalMs);
    this.scanTimer.unref();
  }

  stopScanning(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /** Single scan pass — exported for testing. */
  scanQuiescent(): void {
    const now = Date.now();
    const threshold = QUIESCENCE_TIMEOUT_S * 1000;

    for (const conn of this.connections.values()) {
      const state = this.drainController.getState(conn.socketId);
      if (state !== ConnectionState.Active) continue;

      if (now - conn.lastActivityAt >= threshold) {
        this.drainController.initiateDrain(conn.socketId, conn.handle, 'quiescence');
      }
    }
  }

  // ── Health Check ──────────────────────────────────────────────────────

  healthCheck(): HealthStatus {
    const drainingConnections = this.drainController.getDrainingCount();
    return {
      healthy: drainingConnections === 0,
      totalConnections: this.connections.size,
      drainingConnections,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private recordClose(socketId: string): void {
    const conn = this.connections.get(socketId);
    if (!conn) return;

    this.lifecycleBuffer.push({
      socketId,
      connectedAt: conn.connectedAt,
      lastActivityAt: conn.lastActivityAt,
      closedAt: Date.now(),
    });

    this.connections.delete(socketId);
  }

  /** Reset all state (for testing). */
  reset(): void {
    this.stopScanning();
    this.drainController.reset();
    this.connections.clear();
    this.lifecycleBuffer.clear();
  }
}
