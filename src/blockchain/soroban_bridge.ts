import { xdr } from '@stellar/stellar-sdk';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

/**
 * Wraps a Soroban JSON-RPC fetch in a `soroban_rpc_call` span (issue #177), so
 * each RPC call becomes a child span of the active request span, with the RPC
 * method and endpoint attached for latency decomposition in Jaeger/Tempo.
 */
async function tracedSorobanFetch(
  rpcUrl: string,
  rpcMethod: string,
  init: RequestInit,
): Promise<Response> {
  const tracer = trace.getTracer('agritrust-soroban');
  return tracer.startActiveSpan(
    'soroban_rpc_call',
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'rpc.system': 'soroban',
        'rpc.method': rpcMethod,
        'server.address': rpcUrl,
      },
    },
    async (span) => {
      try {
        const response = await fetch(rpcUrl, init);
        span.setAttribute('http.status_code', response.status);
        if (!response.ok) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `RPC returned ${response.status}` });
        }
        return response;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export interface HorizonLedger {
  sequence: number;
  closed_at: string;
  transaction_set_hash: string;
  successful_transaction_count: number;
}

export interface HorizonEffect {
  type: string;
  account?: string;
  amount?: string;
  asset_type?: string;
}

export interface HorizonBlockData {
  ledger: HorizonLedger;
  effects: HorizonEffect[];
}

export interface SorobanBridgeConfig {
  horizonUrl: string;
  timeoutMs: number;
  maxRetries: number;
}

export class SorobanBridge {
  private config: SorobanBridgeConfig;

  constructor(config: SorobanBridgeConfig) {
    this.config = config;
  }

  async getLedger(sequence: number): Promise<HorizonLedger | null> {
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

        const response = await fetch(
          `${this.config.horizonUrl}/ledgers/${sequence}`,
          { signal: controller.signal },
        );
        clearTimeout(timeout);

        if (response.status === 404) return null;
        if (!response.ok) {
          throw new Error(`Horizon returned ${response.status}`);
        }

        const data = (await response.json()) as Record<string, unknown>;
        return {
          sequence: Number(data.sequence),
          closed_at: String(data.closed_at),
          transaction_set_hash: String(data.transaction_set_hash),
          successful_transaction_count: Number(data.successful_transaction_count ?? 0),
        };
      } catch (err) {
        if (attempt === this.config.maxRetries) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
    return null;
  }

  async getLedgerEffects(sequence: number): Promise<HorizonEffect[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(
        `${this.config.horizonUrl}/ledgers/${sequence}/effects`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);

      if (!response.ok) return [];
      const data = (await response.json()) as { _embedded?: { records?: HorizonEffect[] } };
      return (data._embedded?.records ?? []) as HorizonEffect[];
    } catch {
      return [];
    }
  }
}

export interface SorobanRpcConfig {
  rpcUrl: string;
  timeoutMs: number;
}

export interface RawSimulationResult {
  transactionData: string;
  minResourceFee: number;
  footprint: string;
  instructions: number;
  readBytes: number;
  writeBytes: number;
  ledgerEntriesRead: number;
  ledgerEntriesWritten: number;
}

export class SorobanRpcClient {
  private config: SorobanRpcConfig;

  constructor(config: SorobanRpcConfig) {
    this.config = config;
  }

  async simulateTransaction(transactionXdr: string): Promise<RawSimulationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await tracedSorobanFetch(this.config.rpcUrl, 'simulateTransaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'simulateTransaction',
          params: { transaction: transactionXdr },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`RPC returned ${response.status}`);
      }

      const json = (await response.json()) as {
        error?: { message: string };
        result?: { transactionData: string; minResourceFee?: number; footprint?: string };
      };
      if (json.error) {
        throw new Error(`RPC error: ${json.error.message}`);
      }

      const result = json.result!;
      const txData = result.transactionData;

      const parsed = decodeSorobanTransactionData(txData);

      return {
        transactionData: txData,
        minResourceFee: result.minResourceFee ?? 0,
        footprint: result.footprint ?? '',
        instructions: parsed.instructions,
        readBytes: parsed.readBytes,
        writeBytes: parsed.writeBytes,
        ledgerEntriesRead: parsed.ledgerEntriesRead,
        ledgerEntriesWritten: parsed.ledgerEntriesWritten,
      };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
}

export interface SorobanSubmitResult {
  hash: string;
  status: 'pending' | 'confirmed' | 'failed';
  ledgerSequence?: number;
  confirmedLedgerHash?: string;
}

export interface SorobanTxStatus {
  status: 'NOT_FOUND' | 'PENDING' | 'SUCCESS' | 'FAILED';
  ledger?: number;
  ledgerHash?: string;
}

/**
 * Extended Soroban RPC client that adds transaction submission and polling
 * for the two-phase commit coordinator.
 */
export class SorobanSubmitter {
  private config: SorobanRpcConfig;

  constructor(config: SorobanRpcConfig) {
    this.config = config;
  }

  /** Submits a signed transaction envelope XDR to the Soroban RPC. */
  async submitTransaction(signedXdr: string): Promise<SorobanSubmitResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await tracedSorobanFetch(this.config.rpcUrl, 'sendTransaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: { transaction: signedXdr },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`RPC returned ${response.status}`);
      }

      const json = (await response.json()) as {
        error?: { message: string };
        result?: { hash: string; status: string; latestLedger?: number };
      };
      if (json.error) {
        throw new Error(`RPC error: ${json.error.message}`);
      }

      const result = json.result!;
      return {
        hash: result.hash,
        status: result.status === 'PENDING' ? 'pending' : 'failed',
        ledgerSequence: result.latestLedger,
      };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /** Polls the Soroban RPC for a transaction's status by hash. */
  async getTransactionStatus(txHash: string): Promise<SorobanTxStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await tracedSorobanFetch(this.config.rpcUrl, 'getTransaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: { hash: txHash },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return { status: 'NOT_FOUND' };
      }

      const json = (await response.json()) as {
        error?: { message: string };
        result?: { status: string; ledger?: number; ledgerHash?: string };
      };

      if (json.error || !json.result) {
        return { status: 'NOT_FOUND' };
      }

      const s = json.result.status;
      const status: SorobanTxStatus['status'] =
        s === 'SUCCESS' ? 'SUCCESS' :
        s === 'FAILED' ? 'FAILED' :
        s === 'NOT_FOUND' ? 'NOT_FOUND' : 'PENDING';

      return {
        status,
        ledger: json.result.ledger,
        ledgerHash: json.result.ledgerHash,
      };
    } catch {
      return { status: 'NOT_FOUND' };
    }
  }

  /**
   * Submits a transaction and polls until it reaches a terminal state or
   * the deadline elapses.  Returns the final status.
   */
  async submitAndConfirm(
    signedXdr: string,
    timeoutMs: number = 30_000,
    pollIntervalMs: number = 2_000,
  ): Promise<SorobanSubmitResult> {
    const submission = await this.submitTransaction(signedXdr);
    if (submission.status === 'failed') {
      return submission;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const status = await this.getTransactionStatus(submission.hash);

      if (status.status === 'SUCCESS') {
        return {
          hash: submission.hash,
          status: 'confirmed',
          ledgerSequence: status.ledger,
          confirmedLedgerHash: status.ledgerHash,
        };
      }
      if (status.status === 'FAILED') {
        return { hash: submission.hash, status: 'failed' };
      }
    }

    return { hash: submission.hash, status: 'pending' };
  }
}

function decodeSorobanTransactionData(transactionDataXdr: string): {
  instructions: number;
  readBytes: number;
  writeBytes: number;
  ledgerEntriesRead: number;
  ledgerEntriesWritten: number;
} {
  try {
    const txData = xdr.SorobanTransactionData.fromXDR(transactionDataXdr, 'base64');
    const resources = txData.resources();
    const footprint = resources.footprint();

    return {
      instructions: resources.instructions(),
      readBytes: resources.diskReadBytes(),
      writeBytes: resources.writeBytes(),
      ledgerEntriesRead: footprint.readOnly().length,
      ledgerEntriesWritten: footprint.readWrite().length,
    };
  } catch {
    return {
      instructions: 0,
      readBytes: 0,
      writeBytes: 0,
      ledgerEntriesRead: 0,
      ledgerEntriesWritten: 0,
    };
  }
}
