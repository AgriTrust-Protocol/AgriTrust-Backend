import { NetSettlementInstruction } from './netting_engine';

export interface SettlementExecutor {
  execute(instruction: NetSettlementInstruction): Promise<void>;
  rollback(instruction: NetSettlementInstruction): Promise<void>;
}

export class RollbackManager {
  constructor(private readonly executor: SettlementExecutor) {}

  async executeGroup(instructions: NetSettlementInstruction[]): Promise<{ committed: boolean; rolledBack: string[] }> {
    const completed: NetSettlementInstruction[] = [];
    try {
      for (const instruction of instructions) {
        await this.executor.execute(instruction);
        completed.push(instruction);
      }
      return { committed: true, rolledBack: [] };
    } catch (error) {
      const rolledBack: string[] = [];
      for (const instruction of completed.reverse()) {
        await this.executor.rollback(instruction);
        rolledBack.push(instruction.id);
      }
      return { committed: false, rolledBack };
    }
  }
}
