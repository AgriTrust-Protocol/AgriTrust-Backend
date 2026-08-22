import { SlidingWindowBuffer } from './buffer_manager';

interface GaugeSnapshot {
  name: string;
  value: number;
  timestamp: Date;
}

class MetricRegistry {
  private gauges: Map<string, GaugeSnapshot> = new Map();
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  setGauge(name: string, value: number): void {
    this.gauges.set(name, { name, value, timestamp: new Date() });
  }

  getGauge(name: string): GaugeSnapshot | undefined {
    return this.gauges.get(name);
  }

  getAllGauges(): GaugeSnapshot[] {
    return Array.from(this.gauges.values());
  }

  prometheusText(): string {
    const lines: string[] = [];
    for (const gauge of this.gauges.values()) {
      lines.push(`# HELP ${gauge.name} ${gauge.name}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      lines.push(`${gauge.name} ${gauge.value}`);
    }
    return lines.join('\n');
  }

  stopAll(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }
}

const registry = new MetricRegistry();

function exposeBufferUtilization(buffer: SlidingWindowBuffer, intervalMs = 5000): () => void {
  const update = () => {
    registry.setGauge('sensor_ingestion_buffer_utilization', buffer.getUtilization());
  };
  update();
  const interval = setInterval(update, intervalMs);
  return () => clearInterval(interval);
}

export { MetricRegistry, registry, exposeBufferUtilization };
