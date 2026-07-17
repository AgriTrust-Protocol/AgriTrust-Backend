# Chaos Engineering Testing in Staging

This blueprint defines how AgriTrust validates resilience in staging without expanding the blast radius beyond controlled, reversible failure injection. It is intentionally gated by security review, blue-green rollback readiness, and canary analysis before any experiment can run.

## Objectives and Bounds

- **Scope:** system-wide staging validation across API, ingestion, Soroban RPC, database, queue, webhook, and observability paths.
- **Performance target:** critical API paths must remain below **100ms P99** during steady state and recover to that target after an injected fault.
- **Availability target:** staging service availability must remain at or above **99.99%** for the experiment window.
- **Security:** every experiment requires security review, tenant-isolation confirmation, and an explicit rollback owner.

## Solution Architecture

1. **Experiment controller** schedules approved scenarios and records the exact start, stop, owner, and rollback command.
2. **Fault injectors** apply bounded latency, error-rate, pod-kill, network-partition, or dependency-timeout faults to one pod, one availability zone, or one dependency at a time.
3. **Steady-state probes** continuously evaluate latency, availability, error budget, and security-policy queries from `stagingChaosBlueprint`.
4. **Abort controller** stops the experiment immediately when any abort condition fires, then confirms that the blue environment can receive traffic.
5. **Evidence store** captures metrics snapshots, alert timelines, incident notes, and runbook changes for post-test review.

## Stage Gates

| Gate | Required evidence |
| --- | --- |
| Design | Architecture diagram reviewed; experiment blast radius approved. |
| Preflight | Security review complete; staging backup verified; rollback owner assigned. |
| Canary | 10% traffic analysis clean; alerts routed to on-call. |
| Blue-green | Green environment healthy; blue rollback tested. |
| Review | Findings recorded; runbook updates merged. |

## Monitoring, Alerting, and Dashboards

Dashboards must show these panels before test execution:

- Critical path P50/P95/P99 latency by route.
- Staging availability and 5xx rate.
- Soroban RPC failover, timeout, and circuit-breaker state.
- Queue depth, retry rate, and dead-letter growth.
- Security-policy violations and tenant-isolation errors.
- Blue-green traffic split and canary comparison.

Alert routes must page the staging on-call for failed abort automation, critical-path P99 at or above 100ms for two consecutive minutes, staging availability below 99.99%, 5xx rate at or above 1%, or any security-policy violation.

## Deployment Strategy

1. Deploy the experiment controller and dashboards to the green staging environment.
2. Shift 10% staging traffic to green and run read-only probes for at least 15 minutes.
3. Run a single canary experiment with the smallest blast radius.
4. Promote additional experiments only when canary analysis shows no SLO or security regression.
5. Keep blue healthy throughout the test window so traffic can be shifted back immediately.

## Runbooks

### api-latency-injection

- **Hypothesis:** API retries, timeouts, and dashboards expose latency while critical paths stay below 100ms P99.
- **Blast radius:** one API pod.
- **Duration:** 10 minutes.
- **Abort if:** critical-path P99 is at or above 100ms for two consecutive minutes, 5xx rate is at or above 1%, or any security-policy violation is observed.
- **Rollback:** stop the injector, drain the affected pod, and route traffic back to blue if latency does not recover within five minutes.

### soroban-rpc-dependency-timeout

- **Hypothesis:** circuit breakers and the RPC load balancer fail over without exhausting the error budget.
- **Blast radius:** one Soroban RPC dependency endpoint.
- **Duration:** 15 minutes.
- **Abort if:** RPC error rate is at or above 2%, circuit breakers remain open without recovery for five minutes, or ledger writes fail validation.
- **Rollback:** disable the timeout rule, remove the unhealthy RPC endpoint from the pool, and confirm ledger health checks pass before resuming.

## Post-Test Review

Within one business day, record the experiment result, SLO impact, alert behavior, mitigation timing, security findings, and follow-up work. No experiment is considered complete until documentation and runbook updates are merged.
