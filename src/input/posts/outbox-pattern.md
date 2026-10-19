---
Title: "The Outbox Pattern in .NET"
Description: "How to make a database state change and a message publication reliable without a distributed transaction."
Category: "ARCHITECTURE"
ReadingTime: "7 min read"
Date: 2026-10-17
Layout: /_PostLayout.cshtml
---

## The gap between the database and the broker

Imagine a customer pays for a subscription. Your Payment Service writes `Paid` to its database and publishes `PaymentCompleted` to a message broker. What happens if the database commit succeeds but publishing the event fails?

Your system has accepted payment but the Subscription Service may never hear about it.

```text
Payment API
   |
   +-- save payment to database  [success]
   |
   +-- publish PaymentCompleted  [failure]
```

## Store the event in the same transaction

With the **transactional outbox**, save both the business record and an event message in the same local database transaction.

```csharp
await using var transaction =
    await db.Database.BeginTransactionAsync(ct);

payment.MarkPaid();

// Persist business state and a pending integration event.
db.OutboxMessages.Add(new OutboxMessage
{
    Id = Guid.NewGuid(),
    Type = "PaymentCompleted",
    Payload = JsonSerializer.Serialize(new { payment.Id })
});

await db.SaveChangesAsync(ct);
await transaction.CommitAsync(ct);
```

`OutboxMessage`, `Payment` and `MarkPaid` are illustrative domain types. A real implementation needs message versioning, durable payload metadata, and an agreed event schema.

## Publish asynchronously

A background publisher reads pending messages, sends them to your broker, and marks them as dispatched **after broker acknowledgment**. If the process crashes, it retries.

```text
Database transaction
  |-- Payment marked Paid
  |-- Outbox row inserted
       |
       v
Outbox publisher --retry--> Message broker
                                  |
                                  v
                          Subscription consumer
```

The outbox gives you **at-least-once delivery**, not magically exactly-once processing. A message may be sent more than once when an acknowledgment is lost.

## The Inbox counterpart

Make the consumer idempotent. One option is an inbox table with a unique key on the message ID. Record that ID and apply the business change within the same transaction where possible.

## Production checklist

- Claim batches safely when multiple publishers run.
- Track attempts, age of unpublished messages, and dead-letter failures.
- Design consumers to tolerate duplicate delivery.
- Keep message contracts stable or versioned.
- Decide retention, cleanup, ordering, and replay policies up front.

The outbox is useful when losing an integration event would be worse than accepting asynchronous delivery and retries.
