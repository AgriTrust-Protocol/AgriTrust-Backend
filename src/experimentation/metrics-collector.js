class MetricsCollector {
  static async fetchMetricSamples(experimentId, metricName) {
    // Standard mock metrics. Connect to your Prometheus wrapper here if needed.
    return {
      baseline: [120, 122, 118, 125, 121, 119, 123, 120, 124, 117],
      canary: [102, 105, 99, 104, 101, 98, 103, 106, 100, 102],
    };
  }

  static calculateMannWhitneyU(sampleA, sampleB) {
    const n1 = sampleA.length;
    const n2 = sampleB.length;

    if (n1 === 0 || n2 === 0) return { uStat: 0, pValue: 1.0 };

    const allItems = [
      ...sampleA.map((v) => ({ value: v, group: 'A', rank: 0 })),
      ...sampleB.map((v) => ({ value: v, group: 'B', rank: 0 })),
    ];

    allItems.sort((a, b) => a.value - b.value);

    let i = 0;
    while (i < allItems.length) {
      let j = i;
      while (j < allItems.length - 1 && allItems[j + 1].value === allItems[i].value) {
        j++;
      }
      const rankSum = ((i + 1 + (j + 1)) * (j - i + 1)) / 2;
      const assignedRank = rankSum / (j - i + 1);
      for (let k = i; k <= j; k++) {
        allItems[k].rank = assignedRank;
      }
      i = j + 1;
    }

    const rankSumA = allItems
      .filter((item) => item.group === 'A')
      .reduce((acc, curr) => acc + curr.rank, 0);

    const u1 = n1 * n2 + (n1 * (n1 + 1)) / 2 - rankSumA;
    const u2 = n1 * n2 - u1;
    const uStat = Math.min(u1, u2);

    const meanU = (n1 * n2) / 2;
    const sigmaU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
    const z = (uStat - meanU) / sigmaU;

    const pValue = 2 * (1 - this.normalDistributionCDF(Math.abs(z)));

    return { uStat, pValue };
  }

  static normalDistributionCDF(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const p =
      d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z >= 0 ? 1 - p : p;
  }
}

module.exports = { MetricsCollector };
