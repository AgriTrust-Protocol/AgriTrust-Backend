export class DeterministicSampler {
  private readonly probability: number;

  constructor(probability: number = 0.8) {
    this.probability = Math.max(0, Math.min(1, probability));
  }

  shouldSample(traceId: string): boolean {
    if (!traceId || traceId.length < 2) {
      return Math.random() < this.probability;
    }

    // Use the first byte (first 2 hex chars) for deterministic decision
    const firstByte = parseInt(traceId.substring(0, 2), 16);
    const threshold = this.probability * 255;

    return firstByte <= threshold;
  }

  getProbability(): number {
    return this.probability;
  }
}
