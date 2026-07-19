export type ScheduledJobKind = 'cron' | 'delayed' | 'dependency';
export type ScheduledJobStatus = 'pending' | 'leased' | 'running' | 'succeeded' | 'failed';

export interface ScheduledJob<T = Record<string, unknown>> {
  jobId: string;
  type: ScheduledJobKind;
  operation: string;
  payload: T;
  scheduledAt: Date;
  leaseUntil: Date | null;
  leaseOwner: string | null;
  status: ScheduledJobStatus;
  retryCount: number;
  cronExpression?: string | null;
  parentJobId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type JobHandler<T = Record<string, unknown>> = (job: ScheduledJob<T>) => Promise<void>;

export interface JobExecutionAlert {
  jobId: string;
  operation: string;
  reason: string;
  retryCount: number;
  timestamp: Date;
}
