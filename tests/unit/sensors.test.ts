import { SlidingWindowBuffer, TelemetryFrame } from '../../src/sensors/buffer_manager';
import { BackpressureController, BackpressureLevel } from '../../src/sensors/backpressure';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

function makeFrame(sensorId: string): TelemetryFrame {
  return {
    sensorId,
    payload: Buffer.alloc(1200),
    timestamp: new Date(),
  };
}

function testBufferBurstLarge(): void {
  const CAPACITY = 100000;
  const HIGH_WATERMARK = Math.floor(CAPACITY * 0.8);
  const TOTAL_FRAMES = 200000;
  const SENSOR_COUNT = 10;

  const buffer = new SlidingWindowBuffer(CAPACITY);
  let pauseCount = 0;
  let pauseAtLength = 0;

  buffer.on('pause', () => {
    pauseCount++;
    pauseAtLength = buffer.getBufferLength();
  });

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    buffer.write(makeFrame(`sensor-${i % SENSOR_COUNT}`));
  }

  assert(
    buffer.getFramesWritten() === TOTAL_FRAMES,
    `All ${TOTAL_FRAMES} frames accounted for in write count`,
  );

  const retained = buffer.getBufferLength();
  assert(
    retained <= CAPACITY,
    `Buffer never exceeds capacity (retained=${retained}, cap=${CAPACITY})`,
  );

  const dropped = buffer.getFramesDropped();
  const expectedDropped = TOTAL_FRAMES - CAPACITY;
  assert(dropped === expectedDropped, `Exactly ${expectedDropped} frames dropped (got ${dropped})`);

  assert(
    pauseCount >= 1,
    `High watermark triggered at least one pause event (paused ${pauseCount} times)`,
  );
  assert(
    pauseAtLength >= HIGH_WATERMARK,
    `Pause triggered when buffer length (${pauseAtLength}) >= highWatermark (${HIGH_WATERMARK})`,
  );

  assert(buffer.isPaused() === true, 'Buffer reports paused state after high water exceeded');

  assert(
    buffer.getEstimatedBytes() === retained * 1200,
    'Estimated bytes matches frame count * 1200',
  );

  const utilization = buffer.getUtilization();
  assert(
    utilization > 0.79 && utilization <= 1.0,
    `Utilization (${utilization}) reflects capacity usage`,
  );

  console.log('  -> 200K burst write test: all assertions passed');
}

function testBufferResumeSmall(): void {
  const CAPACITY = 1000;
  const LOW_WATERMARK = Math.floor(CAPACITY * 0.3);
  const buffer = new SlidingWindowBuffer(CAPACITY);

  let pauseCount = 0;
  let resumeCount = 0;

  buffer.on('pause', () => {
    pauseCount++;
  });
  buffer.on('resume', () => {
    resumeCount++;
  });

  for (let i = 0; i < CAPACITY; i++) {
    buffer.write(makeFrame(`sensor-${i}`));
  }

  assert(pauseCount === 1, 'Pause event fired exactly once after filling buffer to capacity');
  assert(buffer.getBufferLength() === CAPACITY, `Buffer holds ${CAPACITY} frames after filling`);

  const READ_TARGET = CAPACITY - LOW_WATERMARK;
  for (let i = 0; i < READ_TARGET; i++) {
    const frame = buffer.read();
    if (!frame) break;
  }

  assert(
    buffer.getBufferLength() <= LOW_WATERMARK,
    `Buffer drained below lowWatermark (len=${buffer.getBufferLength()} <= ${LOW_WATERMARK})`,
  );
  assert(
    resumeCount >= 1,
    `Resume event emitted after draining below low watermark (resumed ${resumeCount} times)`,
  );
  assert(buffer.isPaused() === false, 'Buffer is no longer in paused state after resume');

  console.log('  -> Buffer resume test: all assertions passed');
}

function testNoSilentDrops(): void {
  const CAPACITY = 1000;
  const TOTAL_FRAMES = 2000;
  const buffer = new SlidingWindowBuffer(CAPACITY);

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    buffer.write(makeFrame(`sensor-${i % 5}`));
  }

  const totalWritten = buffer.getFramesWritten();
  const totalDropped = buffer.getFramesDropped();
  const retained = buffer.getBufferLength();

  assert(
    totalWritten === TOTAL_FRAMES,
    `Write counter matches: ${totalWritten} === ${TOTAL_FRAMES}`,
  );
  assert(
    totalDropped === TOTAL_FRAMES - CAPACITY,
    `Drop counter matches: ${totalDropped} === ${TOTAL_FRAMES - CAPACITY}`,
  );
  assert(retained === CAPACITY, `Retained frames equals capacity: ${retained} === ${CAPACITY}`);

  const observed = totalDropped + retained;
  assert(
    observed === totalWritten,
    `No silent drops: dropped(${totalDropped}) + retained(${retained}) = ${observed} === written(${totalWritten})`,
  );

  console.log('  -> No silent drop test: all assertions passed');
}

function testBackpressureTransitions(): void {
  const bp = new BackpressureController();

  assert(
    bp.getLevel('sensor-alpha') === BackpressureLevel.NORMAL,
    'Initial level is NORMAL for unknown sensor',
  );
  assert(bp.globalBackpressure === false, 'Initial global backpressure is false');

  const changes: Array<{ sensorId: string; prev: BackpressureLevel; next: BackpressureLevel }> = [];
  bp.on('levelChange', (sensorId: string, prev: BackpressureLevel, next: BackpressureLevel) => {
    changes.push({ sensorId, prev, next });
  });

  const globalChanges: boolean[] = [];
  bp.on('globalChange', (value: boolean) => {
    globalChanges.push(value);
  });

  bp.setBackpressure('sensor-alpha', BackpressureLevel.WARNING);
  assert(
    bp.getLevel('sensor-alpha') === BackpressureLevel.WARNING,
    'sensor-alpha level updated to WARNING',
  );
  assert(bp.globalBackpressure === true, 'Global backpressure true after WARNING');
  assert(changes.length === 1, 'One levelChange event emitted for WARNING transition');

  const signal = bp.getSignal('sensor-alpha');
  assert(signal !== undefined && signal[0] === 1, 'Signal byte is 1 (pause) for WARNING level');

  bp.setBackpressure('sensor-alpha', BackpressureLevel.CRITICAL);
  assert(
    bp.getLevel('sensor-alpha') === BackpressureLevel.CRITICAL,
    'sensor-alpha level updated to CRITICAL',
  );
  assert(changes.length === 2, 'LevelChange event for CRITICAL transition');

  bp.setBackpressure('sensor-alpha', BackpressureLevel.NORMAL);
  assert(
    bp.getLevel('sensor-alpha') === BackpressureLevel.NORMAL,
    'sensor-alpha level reset to NORMAL',
  );
  assert(bp.globalBackpressure === false, 'Global backpressure false after all sensors NORMAL');

  const resumeSignal = bp.getSignal('sensor-alpha');
  assert(
    resumeSignal !== undefined && resumeSignal[0] === 0,
    'Signal byte is 0 (resume) for NORMAL level',
  );
  assert(changes.length >= 2, `At least two transitions recorded (got ${changes.length})`);

  const expectedPrev = BackpressureLevel.NORMAL;
  const expectedNext = BackpressureLevel.WARNING;
  assert(
    changes[0].prev === expectedPrev && changes[0].next === expectedNext,
    `First transition: NORMAL -> WARNING`,
  );

  bp.reset();
  assert(
    bp.getLevel('sensor-alpha') === BackpressureLevel.NORMAL,
    'Level reverts to NORMAL after reset',
  );
  assert(bp.globalBackpressure === false, 'Global backpressure false after reset');

  console.log('  -> Backpressure level transitions: all assertions passed');
}

async function main(): Promise<void> {
  console.log('\n=== Sensor Unit Tests ===\n');

  console.log('[Test: 200K burst write]');
  testBufferBurstLarge();

  console.log('\n[Test: Buffer resume through read stream]');
  testBufferResumeSmall();

  console.log('\n[Test: No silent drops]');
  testNoSilentDrops();

  console.log('\n[Test: Backpressure level transitions]');
  testBackpressureTransitions();

  console.log('\n=== All unit tests passed ===');
}

main().catch((err) => {
  console.error('\nTest suite failed:', err);
  process.exit(1);
});
