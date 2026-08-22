const crypto = require('crypto');
const { ExperimentRegistry } = require('./experiment-registry');

class TrafficRouter {
  static getHashBucket(key) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return parseInt(hash.substring(0, 8), 16) % 100;
  }

  static route(tenantId, clientIp) {
    const activeExperiments = ExperimentRegistry.getAll().filter((e) => e.status === 'Running');
    const routingKeyBasis = tenantId || clientIp || 'global-anonymous';

    for (const exp of activeExperiments) {
      if (exp.tenantId && exp.tenantId !== tenantId) {
        continue;
      }

      const routingKey = `${routingKeyBasis}-${exp.id}`;
      const bucket = this.getHashBucket(routingKey);

      let cumulativePercentage = 0;
      for (const variant of exp.variants) {
        cumulativePercentage += variant.trafficPercentage;
        if (bucket < cumulativePercentage) {
          return { experimentId: exp.id, variantName: variant.name };
        }
      }
    }

    return { experimentId: null, variantName: 'baseline' };
  }
}

module.exports = { TrafficRouter };
