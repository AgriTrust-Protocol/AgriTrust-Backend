import * as net from 'net';
import { Transform, TransformCallback } from 'stream';
import { SlidingWindowBuffer, TelemetryFrame } from './buffer_manager';
import { backpressure, BackpressureLevel } from './backpressure';
import { RateLimiter } from '../api/middleware/rate_limit';

const DEFAULT_PORT = 4000;

interface GatewayOptions {
  buffer: SlidingWindowBuffer;
  port?: number;
  rateLimiter?: RateLimiter;
}

function createSensorGateway(
  bufferOrOptions: SlidingWindowBuffer | GatewayOptions,
  port?: number,
): net.Server {
  let buffer: SlidingWindowBuffer;
  let rateLimiter: RateLimiter | undefined;
  let effectivePort: number = DEFAULT_PORT;

  if (bufferOrOptions instanceof SlidingWindowBuffer) {
    buffer = bufferOrOptions;
    if (port !== undefined) {
      effectivePort = port;
    }
  } else {
    buffer = bufferOrOptions.buffer;
    rateLimiter = bufferOrOptions.rateLimiter;
    effectivePort = bufferOrOptions.port ?? DEFAULT_PORT;
  }

  const server = net.createServer((socket) => {
    const sensorId = `${socket.remoteAddress}:${socket.remotePort}`;

    const transform = new Transform({
      objectMode: true,
      transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
        // ── Device-aware rate limiting ──────────────────────────────
        if (rateLimiter) {
          const allowed = rateLimiter.allowRequest(chunk, sensorId);
          if (!allowed) {
            // Throttled: drop the frame silently
            callback(null);
            return;
          }
        }

        // ── Global backpressure check ───────────────────────────────
        if (backpressure.globalBackpressure) {
          socket.pause();
          backpressure.setBackpressure(sensorId, BackpressureLevel.CRITICAL);
          const checkInterval = setInterval(() => {
            if (!backpressure.globalBackpressure) {
              clearInterval(checkInterval);
              socket.resume();
              backpressure.setBackpressure(sensorId, BackpressureLevel.NORMAL);
            }
          }, 50);
          callback(null);
          return;
        }

        const frame: TelemetryFrame = {
          sensorId,
          payload: Buffer.from(chunk),
          timestamp: new Date(),
        };

        const accepted = buffer.write(frame);
        if (!accepted) {
          backpressure.setBackpressure(sensorId, BackpressureLevel.WARNING);
        } else {
          backpressure.setBackpressure(sensorId, BackpressureLevel.NORMAL);
        }

        callback(null);
      },
    });

    socket.pipe(transform);

    socket.on('error', (err) => {
      console.error(`Sensor socket error [${sensorId}]:`, err.message);
    });

    socket.on('close', () => {
      backpressure.setBackpressure(sensorId, BackpressureLevel.NORMAL);
    });
  });

  return server;
}

export { createSensorGateway, DEFAULT_PORT, GatewayOptions };
