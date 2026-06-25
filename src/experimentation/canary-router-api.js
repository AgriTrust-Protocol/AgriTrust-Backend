const express = require('express');
const { ExperimentRegistry } = require('./experiment-registry');
const { CanaryController } = require('./canary-controller');

const router = express.Router();

router.get('/admin/experiments', (req, res) => {
  res.status(200).json(ExperimentRegistry.getAll());
});

router.post('/admin/experiments', (req, res) => {
  const { name, variants, tenantId, evaluationWindowHours } = req.body;

  if (!name || !variants || !Array.isArray(variants)) {
    return res.status(400).json({ error: "Invalid registration payloads." });
  }

  if (evaluationWindowHours < 1 || evaluationWindowHours > 168) {
    return res.status(400).json({ error: "Evaluation windows must be between 1 and 168 hours." });
  }

  const allowedIncrements = [1, 5, 10, 25, 50];
  const totalTraffic = variants.reduce((acc, v) => acc + v.trafficPercentage, 0);
  
  for (const variant of variants) {
    if (!allowedIncrements.includes(variant.trafficPercentage)) {
      return res.status(400).json({ error: "Traffic splits must be 1%, 5%, 10%, 25%, or 50%." });
    }
  }

  if (totalTraffic > 100) {
    return res.status(400).json({ error: "Total variant layout percentage cannot exceed 100%." });
  }

  try {
    const experiment = ExperimentRegistry.create({ name, variants, tenantId, evaluationWindowHours });
    ExperimentRegistry.updateStatus(experiment.id, 'Running');
    res.status(201).json(experiment);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

router.post('/admin/experiments/:id/promote', (req, res) => {
  const exp = ExperimentRegistry.get(req.params.id);
  if (!exp) return res.status(404).json({ error: "Experiment reference not found." });

  CanaryController.executePromotion(exp.id);
  res.status(200).json({ message: "Experiment manually promoted.", experiment: ExperimentRegistry.get(exp.id) });
});

router.post('/admin/experiments/:id/rollback', (req, res) => {
  const exp = ExperimentRegistry.get(req.params.id);
  if (!exp) return res.status(404).json({ error: "Experiment reference not found." });

  CanaryController.executeRollback(exp.id, "Manually triggered via Administrator API invoke.");
  res.status(200).json({ message: "Experiment manually rolled back.", experiment: ExperimentRegistry.get(exp.id) });
});

module.exports = { AdminExperimentRouter: router };