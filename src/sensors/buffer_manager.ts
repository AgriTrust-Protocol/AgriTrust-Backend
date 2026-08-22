import { Readable, ReadableOptions } from 'stream';

interface TelemetryFrame {
  sensorId: string;
  payload: Buffer;
  timestamp: Date;
}

const FRAME_SIZE = 1200;

class SlidingWindowBuffer extends Readable {
  private buffer: TelemetryFrame[] = [];
  private capacity: number;
  private highWatermark: number;
  private lowWatermark: number;
  private framesWritten = 0;
  private framesDropped = 0;
  private _paused = false;

  constructor(capacity = 100000, opts?: ReadableOptions) {
    super({
      objectMode: true,
      highWaterMark: 1024,
      ...opts,
    });
    this.capacity = capacity;
    this.highWatermark = Math.floor(capacity * 0.8);
    this.lowWatermark = Math.floor(capacity * 0.3);
  }

  write(frame: TelemetryFrame): boolean {
    this.framesWritten++;

    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
      this.framesDropped++;
    }

    this.buffer.push(frame);

    if (!this._paused && this.buffer.length >= this.highWatermark) {
      this._paused = true;
      this.emit('pause');
    }

    return !this._paused;
  }

  _read(_size: number): void {
    while (this.buffer.length > 0) {
      if (!this.push(this.buffer.shift()!)) break;
    }

    if (this._paused && this.buffer.length <= this.lowWatermark) {
      this._paused = false;
      this.emit('resume');
    }
  }

  getUtilization(): number {
    if (this.capacity === 0) return 0;
    return this.buffer.length / this.capacity;
  }

  isPaused(): boolean {
    return this._paused;
  }

  getFramesWritten(): number {
    return this.framesWritten;
  }

  getFramesDropped(): number {
    return this.framesDropped;
  }

  getBufferLength(): number {
    return this.buffer.length;
  }

  getEstimatedBytes(): number {
    return this.buffer.length * FRAME_SIZE;
  }
}

export { SlidingWindowBuffer, TelemetryFrame, FRAME_SIZE };
