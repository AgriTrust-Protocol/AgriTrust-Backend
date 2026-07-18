const { TrafficRouter } = require('../experimentation/traffic-router');

function experimentMiddleware(req, res, next) {
  const tenantId = req.headers['x-tenant-id'] || req.query.tenantId || '';
  const clientIp = req.ip || '';

  const assignment = TrafficRouter.route(tenantId, clientIp);
  req.experimentContext = assignment;

  if (assignment.experimentId) {
    res.setHeader('X-Experiment-Id', assignment.experimentId);
    res.setHeader('X-Variant-Name', assignment.variantName);
  } else {
    res.setHeader('X-Variant-Name', 'baseline');
  }

  next();
}

module.exports = { experimentMiddleware };