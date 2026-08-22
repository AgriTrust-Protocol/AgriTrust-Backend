import { EventEmitter } from 'events';

enum BackpressureLevel {
  NORMAL = 0,
  WARNING = 1,
  CRITICAL = 2,
}

class BackpressureController extends EventEmitter {
  private levels: Map<string, BackpressureLevel> = new Map();
  private signals: Map<string, Buffer> = new Map();
  globalBackpressure = false;

  setBackpressure(sensorId: string, level: BackpressureLevel): void {
    const prev = this.levels.get(sensorId) ?? BackpressureLevel.NORMAL;

    if (prev === level) return;

    this.levels.set(sensorId, level);

    const signal = Buffer.alloc(1);
    signal[0] = level === BackpressureLevel.NORMAL ? 0 : 1;
    this.signals.set(sensorId, signal);

    this.emit('levelChange', sensorId, prev, level);

    const newGlobal = this.computeGlobal();
    if (newGlobal !== this.globalBackpressure) {
      this.globalBackpressure = newGlobal;
      this.emit('globalChange', this.globalBackpressure);
    }
  }

  getLevel(sensorId: string): BackpressureLevel {
    return this.levels.get(sensorId) ?? BackpressureLevel.NORMAL;
  }

  getSignal(sensorId: string): Buffer | undefined {
    return this.signals.get(sensorId);
  }

  private computeGlobal(): boolean {
    let max: BackpressureLevel = BackpressureLevel.NORMAL;
    for (const level of this.levels.values()) {
      if (level > max) max = level;
    }
    return max >= BackpressureLevel.WARNING;
  }

  reset(): void {
    this.levels.clear();
    this.signals.clear();
    this.globalBackpressure = false;
  }
}

const backpressure = new BackpressureController();

export { BackpressureController, BackpressureLevel, backpressure };
