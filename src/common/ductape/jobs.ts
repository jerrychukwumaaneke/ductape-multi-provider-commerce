import Ductape from '@ductape/sdk';
import { InventoryService } from '../../modules/inventory/inventory.service.js';

export class DuctapeJobScheduler {
  private localTimer: NodeJS.Timeout | null = null;
  public totalReapedCount = 0;

  constructor(
    private readonly ductape: Ductape,
    private readonly inventoryService: InventoryService
  ) {}

  public async registerReservationExpiryJob(): Promise<void> {
    const jobs = (this.ductape as any).jobs;
    const product = process.env.DUCTAPE_PRODUCT || 'xavier_space:commerce_backend';

    // Ductape's remote jobs (IProductJobs) are serverless cloud event dispatchers requiring a registered
    // Ductape App and Event (JobEventTypes). They cannot execute in-process Node.js domain methods
    // (like inventoryService.reapExpiredReservations()). In-process reservation expiry permanently uses
    // the local scheduler.
    if (typeof jobs?.list === 'function') {
      try {
        await jobs.list(product);
      } catch (err: any) {
        console.warn(
          `[DuctapeJobScheduler] Remote job service check failed (${err?.message || err}). Falling back to local scheduler.`
        );
      }
    }
  }

  private isReaping = false;

  public startLocalReaper(intervalMs = 1000): void {
    if (this.localTimer) return;
    this.localTimer = setInterval(async () => {
      if (this.isReaping) return;
      this.isReaping = true;
      try {
        const reaped = await this.inventoryService.reapExpiredReservations();
        if (reaped > 0) {
          this.totalReapedCount += reaped;
          console.log(`[ReservationReaper] Reaped ${reaped} expired reservation(s). Total reaped: ${this.totalReapedCount}`);
        }
      } catch (err) {
        console.error('[ReservationReaper] Reaper execution failed:', err);
      } finally {
        this.isReaping = false;
      }
    }, intervalMs);
    this.localTimer.unref();
  }

  public stopLocalReaper(): void {
    if (this.localTimer) {
      clearInterval(this.localTimer);
      this.localTimer = null;
    }
  }

  public async triggerExpiryExecution(): Promise<number> {
    return this.inventoryService.reapExpiredReservations();
  }
}
