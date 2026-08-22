import { PowerMetrics } from '../../devices/types';

/**
 * Extracted device context from an incoming sensor connection.
 */
export interface DeviceContext {
  /** Unique device identifier (e.g., from mTLS cert CN, JWT claim, or header). */
  deviceId: string | null;
  /** Fallback identifier based on IP:port when deviceId is absent. */
  fallbackId: string;
  /** Power metrics extracted from the telemetry frame, if any. */
  powerMetrics: PowerMetrics | null;
  /** Firmware version string from the frame, if any. */
  firmwareVersion: string | null;
}

/**
 * Parses a device context from the raw payload buffer.
 *
 * In a TCP sensor gateway, device metadata can be embedded in the first bytes
 * of the payload as a simple binary header.  This function attempts to extract
 * that metadata.  If parsing fails, it falls back to a minimal context using
 * only the connection-level fallbackId (IP:port).
 *
 * Wire format (first 38 bytes of payload):
 *   - Bytes  0-15 : deviceId  (ASCII, space-padded)
 *   - Byte  16    : battery_level (uint8: 0-100)
 *   - Byte  17    : signal_strength (int8: dBm as signed byte, e.g. -85)
 *   - Bytes 18-31 : firmwareVersion (ASCII, space-padded)
 *   - Byte  32    : firmwareOutdated (uint8: 0 or 1)
 *   - Bytes 33-37 : reserved
 *
 * If the payload is shorter than 38 bytes or the deviceId field is all spaces,
 * deviceId is treated as null and the caller should fall back to IP-based limiting.
 */
export function extractDeviceContext(payload: Buffer, fallbackId: string): DeviceContext {
  const ctx: DeviceContext = {
    deviceId: null,
    fallbackId,
    powerMetrics: null,
    firmwareVersion: null,
  };

  if (payload.length < 38) {
    return ctx;
  }

  const rawDeviceId = payload.subarray(0, 16).toString('ascii').trim();
  if (rawDeviceId.length > 0) {
    ctx.deviceId = rawDeviceId;
  }

  const battery = payload.readUInt8(16);
  if (battery <= 100) {
    const signalRaw = payload.readInt8(17);
    ctx.powerMetrics = {
      battery_level: battery,
      signal_strength: signalRaw,
    };
  }

  const rawFirmware = payload.subarray(18, 32).toString('ascii').trim();
  if (rawFirmware.length > 0) {
    ctx.firmwareVersion = rawFirmware;
  }

  return ctx;
}

/**
 * Returns the effective device identifier for rate-limiting.
 *
 * Prefers the authenticated deviceId; falls back to the connection's
 * fallbackId (IP:port) when deviceId is absent.
 */
export function getLimiterKey(ctx: DeviceContext): string {
  return ctx.deviceId ?? ctx.fallbackId;
}
