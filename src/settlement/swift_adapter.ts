import { NetSettlementInstruction } from './netting_engine';

export interface SwiftGateway {
  submit(message: string): Promise<{ messageId: string; accepted: boolean }>;
}

export class SwiftAdapter {
  constructor(private readonly gateway: SwiftGateway) {}

  buildPacs008(instruction: NetSettlementInstruction): string {
    if (instruction.rail !== 'swift') throw new Error('SWIFT adapter only accepts swift instructions');
    return [
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">',
      '<FIToFICstmrCdtTrf>',
      `<GrpHdr><MsgId>${instruction.id}</MsgId><NbOfTxs>1</NbOfTxs></GrpHdr>`,
      '<CdtTrfTxInf>',
      `<PmtId><EndToEndId>${instruction.groupId}</EndToEndId></PmtId>`,
      `<IntrBkSttlmAmt Ccy="${instruction.currency}">${instruction.amount.toFixed(2)}</IntrBkSttlmAmt>`,
      `<Dbtr><Nm>${instruction.debtor}</Nm></Dbtr>`,
      `<Cdtr><Nm>${instruction.creditor}</Nm></Cdtr>`,
      '</CdtTrfTxInf>',
      '</FIToFICstmrCdtTrf>',
      '</Document>',
    ].join('');
  }

  async submit(instruction: NetSettlementInstruction): Promise<{ messageId: string; accepted: boolean }> {
    return this.gateway.submit(this.buildPacs008(instruction));
  }
}
