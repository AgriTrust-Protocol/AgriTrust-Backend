import { describe, expect, it } from 'vitest';
import { DependencyResolver } from '../../src/scheduler/dependency_resolver';
import { ScheduledJob } from '../../src/scheduler/types';

function job(id: string, depends_on?: string[], type: string = 'dependency'): ScheduledJob {
  return {
    job_id: id,
    type: type as ScheduledJob['type'],
    payload: { operation: id },
    scheduled_at: new Date(),
    lease_until: null,
    lease_owner: null,
    status: 'pending',
    retry_count: 0,
    cron_expr: null,
    depends_on: depends_on ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('DependencyResolver', () => {
  const resolver = new DependencyResolver();

  it('releases a dependent when its only upstream completes', () => {
    const map = new Map([
      ['a', job('a', undefined, 'delayed')],
      ['b', job('b', ['a'])],
    ]);
    const result = resolver.resolve('a', map, new Set(['a']));
    expect(result).toEqual(['b']);
  });

  it('keeps a dependent blocked while other upstreams are pending', () => {
    const map = new Map([
      ['a', job('a', undefined, 'delayed')],
      ['x', job('x', undefined, 'delayed')],
      ['b', job('b', ['a', 'x'])],
    ]);
    const result = resolver.resolve('a', map, new Set(['a']));
    expect(result).toEqual([]);
  });

  it('releases a dependent once every upstream has succeeded', () => {
    const map = new Map([
      ['a', job('a', undefined, 'delayed')],
      ['x', job('x', undefined, 'delayed')],
      ['b', job('b', ['a', 'x'])],
    ]);
    const result = resolver.resolve('x', map, new Set(['a', 'x']));
    expect(result).toEqual(['b']);
  });

  it('does not release a dependent on an unrelated completion', () => {
    const map = new Map([['b', job('b', ['a'])]]);
    const result = resolver.resolve('z', map, new Set(['z']));
    expect(result).toEqual([]);
  });

  it('does not re-release a job that already ran', () => {
    const done = job('b', ['a']);
    done.status = 'succeeded';
    const map = new Map([
      ['a', job('a', undefined, 'delayed')],
      ['b', done],
    ]);
    const result = resolver.resolve('a', map, new Set(['a', 'b']));
    expect(result).toEqual([]);
  });

  it('ignores non-dependency jobs', () => {
    const map = new Map([
      ['a', job('a', undefined, 'delayed')],
      ['cron', job('cron', ['a'], 'cron')],
    ]);
    const result = resolver.resolve('a', map, new Set(['a']));
    expect(result).toEqual([]);
  });
});
