class ExperimentRegistry {
  static experiments = new Map();

  static create(experiment) {
    if (this.getActiveCount() >= 5) {
      throw new Error("Maximum concurrent experiments limit (5) reached.");
    }
    
    const id = Math.random().toString(36).substring(2, 11);
    const newExperiment = {
      ...experiment,
      id,
      status: 'Created',
      createdAt: new Date()
    };
    this.experiments.set(id, newExperiment);
    return newExperiment;
  }

  static get(id) {
    return this.experiments.get(id);
  }

  static getAll() {
    return Array.from(this.experiments.values());
  }

  static updateStatus(id, status) {
    const exp = this.experiments.get(id);
    if (exp) {
      exp.status = status;
      if (status === 'Running' && !exp.startedAt) {
        exp.startedAt = new Date();
      }
      this.experiments.set(id, exp);
    }
  }

  static getActiveCount() {
    return Array.from(this.experiments.values()).filter(
      e => e.status === 'Running' || e.status === 'Evaluating'
    ).length;
  }
}

module.exports = { ExperimentRegistry };