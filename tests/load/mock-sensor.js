const http = require('http');

let nextId = 0;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function shouldTrigger(probability) {
  return Math.random() < probability;
}

class MockSensor {
  constructor(config, stats) {
    this.id = `sensor-${++nextId}`;
    this.config = config;
    this.stats = stats;
    this.active = false;
    this.requestCount = 0;
    this.timeoutIds = [];
  }

  async run() {
    this.active = true;
    await this.connect();
    while (this.active) {
      const interval = randomBetween(
        this.config.telemetryIntervalMs.min,
        this.config.telemetryIntervalMs.max,
      );
      await this.sleep(interval);

      if (!this.active) break;

      if (shouldTrigger(this.config.dropoutProbability)) {
        await this.simulateDropout();
        continue;
      }

      await this.sendTelemetry();
    }
  }

  connect() {
    return new Promise((resolve) => {
      const connectDelay = randomBetween(0, 100);
      const timer = setTimeout(() => {
        this.stats.connections++;
        resolve();
      }, connectDelay);
      this.timeoutIds.push(timer);
    });
  }

  sendTelemetry() {
    return new Promise((resolve) => {
      const jitter = randomBetween(this.config.jitterMs.min, this.config.jitterMs.max);

      const shouldDelay = shouldTrigger(this.config.outOfOrderProbability);
      const actualDelay = shouldDelay ? jitter + 5000 : jitter;

      const timer = setTimeout(() => {
        const start = Date.now();
        const req = http.get(
          `http://${this.config.target.host}:${this.config.target.port}${this.config.target.endpoint}`,
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
              const latency = Date.now() - start;
              this.stats.recordLatency(latency);
              this.stats.messagesReceived++;
              this.requestCount++;
              resolve();
            });
          },
        );
        req.on('error', () => {
          this.stats.errors++;
          resolve();
        });
        this.stats.messagesSent++;
      }, actualDelay);

      this.timeoutIds.push(timer);
    });
  }

  simulateDropout() {
    return new Promise((resolve) => {
      this.stats.dropouts++;
      const delay = randomBetween(
        this.config.reconnectDelayMs.min,
        this.config.reconnectDelayMs.max,
      );
      const timer = setTimeout(async () => {
        this.stats.reconnections++;
        await this.connect();
        resolve();
      }, delay);
      this.timeoutIds.push(timer);
    });
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.timeoutIds.push(timer);
    });
  }

  stop() {
    this.active = false;
    for (const id of this.timeoutIds) {
      clearTimeout(id);
    }
    this.timeoutIds = [];
  }
}

module.exports = { MockSensor };
