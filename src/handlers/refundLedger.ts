import type { RefundRequested } from '../bus/events';
import type { Message, Subscriber } from '../bus/inMemoryBus';
import type { PaymentGateway } from '../integrations/paymentGateway';

/** One line in the refund ledger. */
export interface LedgerEntry {
  entryId: string;
  bookingId: string;
  organizer: string;
  amountCents: number;
  reason: string;
  recordedAtMinute: number;
}

/**
 * Books refunds and sends the money back.
 *
 * For a refund message the handler writes a ledger entry, then calls the
 * payment provider for the same amount. The ledger is append only: entries are
 * numbered in the order they were written, and nothing edits or removes one
 * after the fact.
 */
export class RefundLedger implements Subscriber<RefundRequested> {
  readonly name = 'RefundLedger';

  private readonly entries: LedgerEntry[] = [];
  /** One ledger entry per bus message, including an entry whose payment is being retried. */
  private readonly entriesByMessageId = new Map<string, LedgerEntry>();
  /** Messages for which both the ledger entry and payment-provider call completed. */
  private readonly completedMessageIds = new Set<string>();
  private readonly gateway: PaymentGateway;

  constructor(gateway: PaymentGateway) {
    this.gateway = gateway;
  }

  handle(message: Message<RefundRequested>): void {
    if (this.completedMessageIds.has(message.id)) {
      return;
    }

    const event = message.payload;
    if (!this.entriesByMessageId.has(message.id)) {
      const entry: LedgerEntry = {
        entryId: `led-${this.entries.length + 1}`,
        bookingId: event.bookingId,
        organizer: event.organizer,
        amountCents: event.amountCents,
        reason: event.reason,
        recordedAtMinute: message.publishedAtMinute,
      };
      this.entries.push(entry);
      this.entriesByMessageId.set(message.id, entry);
    }
    this.gateway.refund(event.bookingId, event.amountCents);
    this.completedMessageIds.add(message.id);
  }

  /** Every ledger entry, oldest first. */
  all(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Entries for one booking, oldest first. */
  forBooking(bookingId: string): LedgerEntry[] {
    return this.all().filter((entry) => entry.bookingId === bookingId);
  }

  /** What the ledger says has been refunded, in cents. */
  totalRefundedCents(): number {
    return this.entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  }

  size(): number {
    return this.entries.length;
  }
}
