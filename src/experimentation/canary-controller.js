const { ExperimentRegistry } = require('./experiment-registry');
const { MetricsCollector } = require('./metrics-collector');

class CanaryController {
  static intervalId = null;

  static startDaemon() {
    if (this.intervalId) return;

    this.intervalId = setInterval(
      async () => {
        await this.evaluateActiveExperiments();
      },
      5 * 60 * 1000,
    );
  }

  static stopDaemon() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  static async evaluateActiveExperiments() {
    const activeExperiments = ExperimentRegistry.getAll().filter(
      (e) => e.status === 'Running' || e.status === 'Evaluating',
    );

    for (const exp of activeExperiments) {
      try {
        const successMetrics = await MetricsCollector.fetchMetricSamples(
          exp.id,
          'settlement_success_rate',
        );
        const avgBaselineSuccess =
          successMetrics.baseline.reduce((a, b) => a + b, 0) / successMetrics.baseline.length;
        const avgCanarySuccess =
          successMetrics.canary.reduce((a, b) => a + b, 0) / successMetrics.canary.length;

        if (avgBaselineSuccess - avgCanarySuccess >= 0.05) {
          this.executeRollback(
            exp.id,
            `Automatic Rollback: Canary success rate dropped >5% below baseline.`,
          );
          continue;
        }

        if (exp.startedAt) {
          const hoursRunning = (new Date().getTime() - exp.startedAt.getTime()) / (1000 * 60 * 60);

          if (hoursRunning >= exp.evaluationWindowHours) {
            const latencyMetrics = await MetricsCollector.fetchMetricSamples(exp.id, 'latency');
            const stats = MetricsCollector.calculateMannWhitneyU(
              latencyMetrics.baseline,
              latencyMetrics.canary,
            );

            if (stats.pValue < 0.05) {
              this.executePromotion(exp.id);
            } else {
              this.executeRollback(
                exp.id,
                `Expired without statistical significance (p = ${stats.pValue.toFixed(4)}).`,
              );
            }
          } else if (hoursRunning >= 1 && exp.status === 'Running') {
            ExperimentRegistry.updateStatus(exp.id, 'Evaluating');
          }
        }
      } catch (error) {
        console.error(`Error processing lifecycle metrics for experiment ${exp.id}:`, error);
      }
    }
  }

  static executePromotion(id) {
    ExperimentRegistry.updateStatus(id, 'Promoted');
    console.log(`[ALERT] Experiment ${id} promoted.`);
  }

  static executeRollback(id, reason) {
    ExperimentRegistry.updateStatus(id, 'RolledBack');
    console.error(`[CRITICAL ALERT] Experiment ${id} rolled back. Reason: ${reason}`);
  }
}

module.exports = { CanaryController };
