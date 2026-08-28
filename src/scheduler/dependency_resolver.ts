import { ScheduledJob } from './types';

/**
 * DAG-based dependency resolution for `dependency` jobs (issue #168).
 *
 * A dependency job declares the set of upstream job ids it needs to complete
 * before it may run. When an upstream job reaches a terminal state, the
 * resolver decides which dependency jobs are now runnable: all their upstreams
 * must be successful already (an upstream that failed blocks dependents).
 */
export class DependencyResolver {
  /**
   * Given a completed job id and the known scheduled jobs, return the ids of
   * dependency jobs whose entire upstream set has succeeded.
   *
   * @param completedJobId the job that just finished (succeeded or failed)
   * @param jobs           current snapshot of scheduled jobs, by id
   * @param succeeded      set of job ids currently in the `succeeded` state
   */
  resolve(
    completedJobId: string,
    jobs: ReadonlyMap<string, ScheduledJob>,
    succeeded: ReadonlySet<string>,
  ): string[] {
    const runnable: string[] = [];

    for (const job of jobs.values()) {
      if (job.type !== 'dependency') continue;
      if (job.status === 'succeeded' || job.status === 'running') continue;
      const upstreams = job.depends_on ?? [];
      if (!upstreams.includes(completedJobId)) continue;

      const ready = upstreams.every((up) => succeeded.has(up));
      if (ready) runnable.push(job.job_id);
    }

    return runnable;
  }
}
