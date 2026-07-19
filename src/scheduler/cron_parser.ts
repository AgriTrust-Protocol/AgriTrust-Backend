const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);
    const [startText, endText] = rangePart === '*' ? [String(min), String(max)] : rangePart.split('-');
    const start = Number(startText);
    const end = Number(endText ?? startText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron field: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export class CronExpression {
  private readonly fields: Set<number>[];

  constructor(expression: string) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error('Cron expression must use standard 5-field format');
    this.fields = parts.map((part, i) => parseField(part, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
  }

  matches(date: Date): boolean {
    return this.fields[0].has(date.getUTCMinutes())
      && this.fields[1].has(date.getUTCHours())
      && this.fields[2].has(date.getUTCDate())
      && this.fields[3].has(date.getUTCMonth() + 1)
      && this.fields[4].has(date.getUTCDay());
  }

  nextAfter(after: Date): Date {
    const next = new Date(after.getTime() + 1000);
    next.setUTCSeconds(0, 0);
    for (let i = 0; i < 366 * 24 * 60; i++) {
      if (this.matches(next)) return next;
      next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    throw new Error('No cron occurrence found within one year');
  }
}
