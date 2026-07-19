export type YieldSourceType = 'satellite' | 'iot' | 'drone' | 'manual';
export type YieldUnit = 'kg_per_hectare' | 'tonnes_per_hectare' | 'bushels_per_acre';

export interface YieldReport {
  farmId: string;
  seasonId: string;
  sourceType: YieldSourceType;
  value: number;
  unit: YieldUnit;
  timestamp: Date;
  reporterId: string;
}

export interface NormalizedYieldReport extends Omit<YieldReport, 'value' | 'unit'> {
  value: number;
  unit: 'kg_per_hectare';
  sourceId: string;
}

const KG_PER_HECTARE_PER_TONNE_PER_HECTARE = 1000;
const KG_PER_HECTARE_PER_BUSHEL_PER_ACRE = 67.251069;

export function sourceIdFor(report: Pick<YieldReport, 'sourceType' | 'reporterId'>): string {
  return `${report.sourceType}:${report.reporterId}`;
}

export function normalizeYieldReport(report: YieldReport): NormalizedYieldReport {
  if (!Number.isFinite(report.value) || report.value < 0) {
    throw new Error(`Yield report value must be a non-negative finite number: ${report.value}`);
  }

  let normalizedValue: number;
  switch (report.unit) {
    case 'kg_per_hectare':
      normalizedValue = report.value;
      break;
    case 'tonnes_per_hectare':
      normalizedValue = report.value * KG_PER_HECTARE_PER_TONNE_PER_HECTARE;
      break;
    case 'bushels_per_acre':
      normalizedValue = report.value * KG_PER_HECTARE_PER_BUSHEL_PER_ACRE;
      break;
    default: {
      const unsupported: never = report.unit;
      throw new Error(`Unsupported yield unit: ${unsupported}`);
    }
  }

  return {
    ...report,
    value: normalizedValue,
    unit: 'kg_per_hectare',
    sourceId: sourceIdFor(report),
  };
}

export function normalizeYieldReports(reports: YieldReport[]): NormalizedYieldReport[] {
  return reports.map(normalizeYieldReport);
}
