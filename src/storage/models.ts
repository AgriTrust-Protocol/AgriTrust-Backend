export interface YieldEstimateRecord {
  farmId: string;
  seasonId: string;
  yieldEstimate: number;
  confidenceLower: number;
  confidenceUpper: number;
  sourceCount: number;
  trustScores: Record<string, number>;
  penaltyFlag: boolean;
  publishedAt: Date;
}
