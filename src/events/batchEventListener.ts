import { MintService } from '../certificate/mintService';

export class BatchEventListener {
  private mintService: MintService;
  private pollInterval = 5000;

  constructor(mintService: MintService) {
    this.mintService = mintService;
  }

  start() {
    console.log('Batch event listener started');
    setInterval(() => this.poll(), this.pollInterval);
  }

  async poll() {
    try {
      // Mock finding a certified batch that needs minting
      // In a real scenario, this would query the DB or Soroban for BatchCertified events
      const batchId = 'batch_event_123';
      const metadata = { source: 'event_listener' };

      console.log(`Event listener triggering mint for batch ${batchId}`);
      const result = await this.mintService.mintCertificate(batchId, metadata);

      if (result.success) {
        console.log(`Successfully minted certificate ${result.certificateId} via event listener`);
      } else {
        console.log(`Event listener minting skip/fail: ${result.error}`);
      }
    } catch (err) {
      console.error('Error in event listener poll:', err);
    }
  }

  // Exposed for testing
  async triggerManualPoll(batchId: string) {
    return this.mintService.mintCertificate(batchId, { source: 'manual_event_trigger' });
  }
}
