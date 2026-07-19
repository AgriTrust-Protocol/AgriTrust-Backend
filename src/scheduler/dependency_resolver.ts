export class DependencyResolver {
  private readonly parents = new Map<string, Set<string>>();
  private readonly children = new Map<string, Set<string>>();
  private readonly completed = new Set<string>();

  addJob(jobId: string, parentJobIds: string[] = []): void {
    if (!this.parents.has(jobId)) this.parents.set(jobId, new Set());
    for (const parent of parentJobIds) {
      if (this.hasPath(jobId, parent)) throw new Error(`Dependency cycle detected: ${parent} -> ${jobId}`);
      this.parents.get(jobId)?.add(parent);
      if (!this.children.has(parent)) this.children.set(parent, new Set());
      this.children.get(parent)?.add(jobId);
    }
  }

  markCompleted(jobId: string): string[] {
    this.completed.add(jobId);
    const ready: string[] = [];
    for (const child of this.children.get(jobId) ?? []) {
      const parents = this.parents.get(child) ?? new Set<string>();
      if ([...parents].every((parent) => this.completed.has(parent))) ready.push(child);
    }
    return ready;
  }

  readyJobs(): string[] {
    return [...this.parents.entries()]
      .filter(([jobId, parents]) => !this.completed.has(jobId) && [...parents].every((parent) => this.completed.has(parent)))
      .map(([jobId]) => jobId);
  }

  private hasPath(from: string, to: string): boolean {
    if (from === to) return true;
    return [...(this.children.get(from) ?? [])].some((child) => this.hasPath(child, to));
  }
}
