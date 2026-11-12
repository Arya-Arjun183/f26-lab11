# EVENTS.md

## Milestone 1: what runs in the request path, and what runs after it

### The operations table

| # | Operation | As wired today | Your call | Why (in one line) |
|---|---|---|---|---|
| 1 | Validate request and check availability | Synchronous in `BookingService.book` | Synchronous | The caller needs an immediate, authoritative yes or rule/conflict error before a room can be held. |
| 2 | Price the requested reservation | Synchronous in `BookingService.book` | Synchronous | The stored booking and the price returned to the organizer must agree. |
| 3 | Save the booking and write its audit record | Synchronous in `BookingService.book` | Synchronous | A successful response must mean the room is actually reserved and auditable. |
| 4 | Add the booking to the room-finder search index | Synchronous in `BookingService.book` | Publish an event; retry/index asynchronously | Search is a derived view, so its outage should not prevent an authoritative reservation. |
| 5 | Queue the booking/cancellation email | `booking.confirmed` / `booking.cancelled` subscriber | Keep event-driven | Email delivery is a side effect that does not decide whether the booking or cancellation succeeded. |
| 6 | Render the receipt | `booking.confirmed` subscriber | Keep event-driven | The receipt is derived from a committed booking and can be regenerated. |
| 7 | Schedule/drop the reminder | `booking.confirmed` / `booking.cancelled` subscriber | Keep event-driven | Reminder state follows the booking and can be corrected from the current store state. |
| 8 | Settle a cancellation refund | `refund.requested` subscriber | Keep event-driven with idempotency and dead-letter recovery | The cancellation should release the room even while a payment provider is temporarily unavailable. |

### Two calls in detail

**Search-index update (row 4) and my call.** A booking caller needs a durable room hold and a clear price before `book` returns; they do not need the room-finder's derived search row to be visible at that instant. I would save and audit the booking, then publish an indexing event for a subscriber that retries/dead-letters failures. If search is down, the caller still receives a confirmed booking, while search may temporarily be stale and operations can replay the index work.

**Refund settlement (row 8) and my call.** A cancelling caller needs the room released and a response that states the refund owed; they do not need to wait for a third-party payment provider on the request path. I would publish the refund work after cancellation and make its handler idempotent. When the provider is unavailable, the cancellation still returns successfully and the refund message is visible for redelivery rather than turning a room-release request into an error.

### The incident

**The call behind `TICKET.md`.** `src/service/bookingService.ts`, `BookingService.book`, line 94 calls `this.searchIndex.indexBooking(booking, room, now)`. When it throws, `book` stops before `store.save`, publishes no confirmation event, and the reservations page/kiosk receives the thrown `SearchIndexUnavailableError` rather than a booking.

## Milestone 2: what a second delivery does

### Your prediction (before you run anything)

**What I expected `redeliver` on a refund message to do.** Before running it, I expected the unguarded handler to append another $85.00 ledger entry, call the provider again and settle another $85.00, while the bus log retained the one refund message with its delivery count increased. No dead letter should appear because the provider is healthy.

### Before your fix

**The run.**

```text
> campus-reservations@1.0.0 demo:replay
> tsx src/demos/replayDemo.ts

booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 2
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
money returned in total: $170.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 3
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-3 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 3
gateway settlements: 3
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
  stl-3 bk-1001 $85.00
money returned in total: $255.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**Your prediction against the run.** It matched: each delivery appended a ledger entry and settled another $85.00; `msg-3` stayed one logged message but reached three deliveries.

### Your fix

**The diff.**

```diff
@@
   private readonly entries: LedgerEntry[] = [];
+  private readonly entriesByMessageId = new Map<string, LedgerEntry>();
+  private readonly completedMessageIds = new Set<string>();
@@
   handle(message: Message<RefundRequested>): void {
+    if (this.completedMessageIds.has(message.id)) {
+      return;
+    }
+
     const event = message.payload;
-    this.entries.push({
-      entryId: `led-${this.entries.length + 1}`,
-      bookingId: event.bookingId,
-      organizer: event.organizer,
-      amountCents: event.amountCents,
-      reason: event.reason,
-      recordedAtMinute: message.publishedAtMinute,
-    });
+    if (!this.entriesByMessageId.has(message.id)) {
+      const entry: LedgerEntry = {
+        entryId: `led-${this.entries.length + 1}`,
+        bookingId: event.bookingId,
+        organizer: event.organizer,
+        amountCents: event.amountCents,
+        reason: event.reason,
+        recordedAtMinute: message.publishedAtMinute,
+      };
+      this.entries.push(entry);
+      this.entriesByMessageId.set(message.id, entry);
+    }
     this.gateway.refund(event.bookingId, event.amountCents);
+    this.completedMessageIds.add(message.id);
   }
```

**What the fix uses to decide what to do on a second delivery, and what it does not protect.** The stable bus `message.id` is the idempotency key: a completed ID returns immediately, while an incomplete ID reuses its existing ledger entry and retries payment. This local state does not protect a crash after the provider accepted money but before `completedMessageIds` was recorded, nor does it make a non-idempotent real payment API safe; that API would need its own durable idempotency key.

### After your fix

**The run.**

```text
> campus-reservations@1.0.0 demo:replay
> tsx src/demos/replayDemo.ts

booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**What stays the same across its three states.** After cancellation, one redelivery, and two redeliveries: ledger entries stay at 1, gateway calls stay at 1, gateway settlements stay at 1, and money returned stays at $85.00. Only `msg-3`'s delivery count changes, from 1 to 2 to 3.

## Milestone 3: a delivery that stops halfway

### The failure

**The run.**

```text
> campus-reservations@1.0.0 demo:failure
> tsx src/demos/failureDemo.ts

armed: call 1 to the payment provider will throw
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3
the cancel call itself returned: booking is cancelled

=== after the failed delivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 0
money returned in total: $0.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=1

redelivering msg-3 after the provider recovered

=== after redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=2
```

### Your recovery

**What, if anything, the failed delivery left undone.** It created the single ledger entry and made one provider call, but that call threw before settlement, so $85.00 had not reached the organizer. The bus recorded the failed attempt as a dead letter; cancellation itself had already completed.

**The option I took and its evidence.** I redelivered `cancellation.refundMessageId` after the provider recovered. The ledger remains one entry, the second provider call creates one $85.00 settlement, and the bus log shows `msg-3 refund.requested deliveries=2`. The original dead letter remains as a historical record, because redelivery does not remove it.

### The other option

**What the option I did not take would have cost.** Manual triage would require a person to inspect the dead letter and retry/settle it later, delaying the organizer's $85.00; it is safe only after they verify from the provider whether the failed call settled, so they do not issue a duplicate refund.
