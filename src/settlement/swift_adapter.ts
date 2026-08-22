/**
 * SWIFT ISO 20022 Adapter
 *
 * Builds pacs.008 (FIToFICustomerCreditTransfer) messages from net settlement
 * instructions and submits them to the SWIFT gateway.
 *
 * Reference: ISO 20022 pacs.008.001.10
 */

import { NetPosition, NettingGroup } from './netting_engine';

export interface SwiftParty {
  /** BIC / SWIFT code of the financial institution. */
  bic: string;
  /** IBAN or account identifier. */
  accountId: string;
  /** Full legal name. */
  name: string;
}

export interface SwiftPartyDirectory {
  /** Looks up the SWIFT party record for an internal party ID. */
  lookup(partyId: string): Promise<SwiftParty | null>;
}

export interface SwiftGatewayClient {
  /** Submits a raw pacs.008 XML message to the SWIFT gateway. */
  submit(messageXml: string): Promise<SwiftSubmitResult>;
}

export interface SwiftSubmitResult {
  /** SWIFT UETR (Unique End-to-end Transaction Reference). */
  uetr: string;
  accepted: boolean;
  rejectionReason?: string;
}

export interface Pacs008Instruction {
  /** Internal instruction reference. */
  instructionId: string;
  /** End-to-end reference visible to both parties. */
  endToEndId: string;
  debtorBic: string;
  debtorAccountId: string;
  debtorName: string;
  creditorBic: string;
  creditorAccountId: string;
  creditorName: string;
  amount: number;
  currency: string;
  /** ISO 8601 settlement date. */
  settlementDate: string;
  /** Original settlement IDs carried in the message's remittance info. */
  remittanceInfo: string;
}

export interface SwiftSettlementResult {
  instructionId: string;
  uetr: string;
  accepted: boolean;
  rejectionReason?: string;
}

/**
 * Builds and submits ISO 20022 pacs.008 messages for a netting group.
 *
 * For each net position in the group:
 *  1. Resolve debtor and creditor SWIFT parties from the directory.
 *  2. Build the pacs.008 XML message.
 *  3. Submit to the SWIFT gateway.
 *  4. Return per-instruction results.
 */
export class SwiftAdapter {
  constructor(
    private readonly directory: SwiftPartyDirectory,
    private readonly gateway: SwiftGatewayClient,
  ) {}

  /**
   * Submits all net positions in a netting group as pacs.008 messages.
   * Skips CCP-leg positions (those involving 'CCP:AGRITRUST') as they are
   * settled via the internal CCP ledger, not SWIFT rails.
   */
  async settleGroup(group: NettingGroup, settlementDate: Date): Promise<SwiftSettlementResult[]> {
    const results: SwiftSettlementResult[] = [];

    for (const position of group.positions) {
      // CCP legs are settled via the CCP ledger, not SWIFT
      if (position.debtorId === 'CCP:AGRITRUST' || position.creditorId === 'CCP:AGRITRUST') {
        continue;
      }

      const result = await this.settlePosition(position, settlementDate);
      results.push(result);
    }

    return results;
  }

  /**
   * Settles a single net position via SWIFT pacs.008.
   */
  async settlePosition(
    position: NetPosition,
    settlementDate: Date,
  ): Promise<SwiftSettlementResult> {
    const debtor = await this.directory.lookup(position.debtorId);
    const creditor = await this.directory.lookup(position.creditorId);

    if (!debtor) {
      return {
        instructionId: position.settlementIds[0] ?? 'unknown',
        uetr: '',
        accepted: false,
        rejectionReason: `No SWIFT party record for debtor: ${position.debtorId}`,
      };
    }

    if (!creditor) {
      return {
        instructionId: position.settlementIds[0] ?? 'unknown',
        uetr: '',
        accepted: false,
        rejectionReason: `No SWIFT party record for creditor: ${position.creditorId}`,
      };
    }

    const instructionId = this.generateInstructionId(position);
    const instruction: Pacs008Instruction = {
      instructionId,
      endToEndId: `AGRI-NET-${instructionId}`,
      debtorBic: debtor.bic,
      debtorAccountId: debtor.accountId,
      debtorName: debtor.name,
      creditorBic: creditor.bic,
      creditorAccountId: creditor.accountId,
      creditorName: creditor.name,
      amount: position.netAmount,
      currency: position.currency,
      settlementDate: settlementDate.toISOString().split('T')[0],
      remittanceInfo: position.settlementIds.join(','),
    };

    const xml = this.buildPacs008(instruction);
    const submitResult = await this.gateway.submit(xml);

    return {
      instructionId,
      uetr: submitResult.uetr,
      accepted: submitResult.accepted,
      rejectionReason: submitResult.rejectionReason,
    };
  }

  /**
   * Builds a minimal but spec-compliant pacs.008.001.10 XML message.
   *
   * Schema reference:
   *   https://www.iso20022.org/catalogue-messages/iso-20022-messages-archive?search=pacs.008
   */
  buildPacs008(instruction: Pacs008Instruction): string {
    const amount = instruction.amount.toFixed(2);

    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.10">\n` +
      `  <FIToFICstmrCdtTrf>\n` +
      `    <GrpHdr>\n` +
      `      <MsgId>${this.escapeXml(instruction.instructionId)}</MsgId>\n` +
      `      <CreDtTm>${new Date().toISOString()}</CreDtTm>\n` +
      `      <NbOfTxs>1</NbOfTxs>\n` +
      `      <SttlmInf>\n` +
      `        <SttlmMtd>CLRG</SttlmMtd>\n` +
      `      </SttlmInf>\n` +
      `    </GrpHdr>\n` +
      `    <CdtTrfTxInf>\n` +
      `      <PmtId>\n` +
      `        <InstrId>${this.escapeXml(instruction.instructionId)}</InstrId>\n` +
      `        <EndToEndId>${this.escapeXml(instruction.endToEndId)}</EndToEndId>\n` +
      `      </PmtId>\n` +
      `      <IntrBkSttlmAmt Ccy="${this.escapeXml(instruction.currency)}">${amount}</IntrBkSttlmAmt>\n` +
      `      <IntrBkSttlmDt>${this.escapeXml(instruction.settlementDate)}</IntrBkSttlmDt>\n` +
      `      <Dbtr>\n` +
      `        <Nm>${this.escapeXml(instruction.debtorName)}</Nm>\n` +
      `      </Dbtr>\n` +
      `      <DbtrAcct>\n` +
      `        <Id><Othr><Id>${this.escapeXml(instruction.debtorAccountId)}</Id></Othr></Id>\n` +
      `      </DbtrAcct>\n` +
      `      <DbtrAgt>\n` +
      `        <FinInstnId><BICFI>${this.escapeXml(instruction.debtorBic)}</BICFI></FinInstnId>\n` +
      `      </DbtrAgt>\n` +
      `      <CdtrAgt>\n` +
      `        <FinInstnId><BICFI>${this.escapeXml(instruction.creditorBic)}</BICFI></FinInstnId>\n` +
      `      </CdtrAgt>\n` +
      `      <Cdtr>\n` +
      `        <Nm>${this.escapeXml(instruction.creditorName)}</Nm>\n` +
      `      </Cdtr>\n` +
      `      <CdtrAcct>\n` +
      `        <Id><Othr><Id>${this.escapeXml(instruction.creditorAccountId)}</Id></Othr></Id>\n` +
      `      </CdtrAcct>\n` +
      `      <RmtInf>\n` +
      `        <Ustrd>${this.escapeXml(instruction.remittanceInfo)}</Ustrd>\n` +
      `      </RmtInf>\n` +
      `    </CdtTrfTxInf>\n` +
      `  </FIToFICstmrCdtTrf>\n` +
      `</Document>`
    );
  }

  private generateInstructionId(position: NetPosition): string {
    const ids = position.settlementIds.join('-');
    // Keep IDs within 35-char SWIFT limit by hashing if needed
    if (ids.length <= 35) return ids;
    // Deterministic truncation: first 8 chars + hash suffix
    const hash = Buffer.from(ids)
      .toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 16);
    return `NET-${hash}`;
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
