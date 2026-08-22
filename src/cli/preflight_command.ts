import { PreflightAnalyzer } from '../blockchain/preflight_analyzer';
import { SorobanRpcClient } from '../blockchain/soroban_bridge';
import { TxBuilder } from '../blockchain/tx_builder';
import { PreflightOptions, PreflightError } from '../blockchain/types';
import { Networks } from '@stellar/stellar-sdk';

function parseArgs(): PreflightOptions {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        opts[key] = value;
        i++;
      } else {
        opts[key] = 'true';
      }
    }
  }

  const contractId = opts['contract-id'];
  const functionName = opts['function'];
  const functionArgsRaw = opts['args'];
  const sourceSecret = opts['source-secret'] || opts['secret'];
  const rpcUrl = opts['rpc-url'] || 'https://soroban-testnet.stellar.org';
  const network = opts['network'] || 'testnet';

  if (!contractId || !functionName || !sourceSecret) {
    console.error(
      'Usage: agritrust preflight --contract-id <id> --function <name> --args <json> --source-secret <secret> [--rpc-url <url>] [--network <testnet|mainnet>]',
    );
    process.exit(1);
  }

  let functionArgs: string[] = [];
  if (functionArgsRaw) {
    try {
      const parsed = JSON.parse(functionArgsRaw);
      functionArgs = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
    } catch {
      functionArgs = [functionArgsRaw];
    }
  }

  const networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

  return {
    contractId,
    functionName,
    functionArgs,
    sourceSecret,
    rpcUrl,
    networkPassphrase,
  };
}

async function main(): Promise<void> {
  try {
    const options = parseArgs();

    const rpcClient = new SorobanRpcClient({
      rpcUrl: options.rpcUrl,
      timeoutMs: 10000,
    });

    const txBuilder = new TxBuilder(options.networkPassphrase);
    const analyzer = new PreflightAnalyzer(rpcClient, txBuilder);

    console.error('Running preflight simulation...');
    const result = await analyzer.analyze(options);

    console.log(
      JSON.stringify(
        {
          resourceFootprint: result.resourceFootprint,
          minResourceFee: result.minResourceFee,
          transactionEnvelopeXdr: result.transactionEnvelopeXdr,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    if (err instanceof PreflightError) {
      console.error('Preflight error:', err.message);
    } else {
      console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }
}

main();
