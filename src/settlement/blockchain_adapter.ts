import { NetSettlementInstruction } from './netting_engine';

export interface PolygonUsdcClient {
  transfer(to: string, amountMicros: bigint, idempotencyKey: string): Promise<{ txHash: string }>;
}

export class BlockchainSettlementAdapter {
  constructor(private readonly client: PolygonUsdcClient) {}

  async batchTransfer(instructions: NetSettlementInstruction[]): Promise<Array<{ instructionId: string; txHash: string }>> {
    const blockchainInstructions = instructions.filter((instruction) => instruction.rail === 'polygon_usdc');
    return Promise.all(blockchainInstructions.map(async (instruction) => {
      const amountMicros = BigInt(Math.round(instruction.amount * 1_000_000));
      const result = await this.client.transfer(instruction.creditor, amountMicros, instruction.id);
      return { instructionId: instruction.id, txHash: result.txHash };
    }));
  }
}
