export interface TelemetryGps {
  lat: number;
  lon: number;
  altitude?: number;
}

export interface TelemetryRecord {
  deviceId: string;
  timestamp: string;
  temperature: number;
  humidity?: number;
  shock?: number;
  gps?: TelemetryGps;
  metadata: Record<string, unknown>;
}
