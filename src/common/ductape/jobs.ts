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
    if (typeof jobs?.create === 'function') {
      try {
        await jobs.create({
          tag: 'reservation-expiry-poller',
          name: 'Reservation Expiry Worker',
          description: 'Releases held inventory reservations whose TTL has expired',
          schedule: {
            cron: '*/1 * * * *', // Run every 1 minute
          },
        });
      } catch (err: any) {
        // Log explicitly without swallowing silently
        console.warn(
          `[DuctapeJobScheduler] Remote job registration unavailable (${err?.message || err}). Falling back to local scheduler.`
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
