---
Title: "The Outbox Pattern in .NET: Reliable Events Without Distributed Transactions"
Description: "Learn the transactional Outbox and Inbox patterns with PostgreSQL, EF Core, Npgsql, background workers, retries, idempotency and production failure scenarios."
Category: "ARCHITECTURE"
ReadingTime: "16 min read"
Date: 2026-10-22
Layout: /_PostLayout.cshtml
Tags:
  - dotnet
  - csharp
  - outbox-pattern
  - microservices
  - ef-core
  - postgresql
  - distributed-systems
Image: "/assets/images/outbox/transactional-outbox.png"
---

*Your database committed the payment. Your event never reached the subscription service. Now what?*

A payment can succeed while the event that should activate a subscription disappears. The **Transactional Outbox** solves this dual-write problem by committing the business change and a pending event to **one database transaction**, then publishing asynchronously.

> **The core guarantee:** If the business transaction commits, its integration event is durably recorded for eventual publication. **Not** exactly-once delivery. Consumers still need idempotency.

**In this guide:** the failure scenario, atomic EF Core writes, a lease-based PostgreSQL publisher, idempotent Inbox processing, monitoring, and a clickable walkthrough.

## 1. The production incident: a paid customer without access

Imagine a subscription platform. A customer pays for Premium. The Payment Service saves `Paid`, then tries to publish a `PaymentCompleted` event. At precisely the wrong moment, the broker times out or the application crashes.

![Without an Outbox, the payment commits but publishing can fail, leaving the subscription inactive.](/assets/images/outbox/failure-scenario.png)

*Figure 1. Two independent writes create a failure window: the database commit succeeds, but event publication fails.*

A common response is: “Just publish first.” That reverses the problem. If the broker accepts the event but the database write fails, downstream services may act on a payment that never committed.

| Order of operations | Failure window | Result |
|---|---|---|
| Save payment → publish event | Crash after commit, before publish | Payment exists; event missing |
| Publish event → save payment | Crash after publish, before commit | Event exists; payment may not |
| **Save payment + Outbox atomically** | Broker unavailable later | Event remains pending and can be retried |

## 2. The solution: commit the event with the payment

In the Outbox approach, the service writes a `Payment` record and an `OutboxMessage` record **in the same local database transaction**. A separate publisher reads pending rows and sends the messages to a broker.

![Payment Service commits Payments and OutboxMessages in PostgreSQL; worker later publishes to broker.](/assets/images/outbox/transactional-outbox.png)

*Figure 2. One atomic write to PostgreSQL, followed by asynchronous publication. The Outbox message remains durable during broker outages.*

This buys you **atomic persistence**, **eventual publication under eventual recovery**, and **at-least-once delivery**. It does not make your database and broker participate in one distributed transaction.

## 3. Implement the atomic write with EF Core

The following reference implementation uses **.NET, EF Core, PostgreSQL and Npgsql**. It assumes you already have a valid payment-authorization workflow; it focuses on the boundary after a payment is confirmed. The event contract includes a stable message ID, a version, and a timestamp.

### 3.1 Define the persistence entities

**`Payment.cs`**

```csharp
public sealed class Payment
{
    public Guid Id { get; set; }
    public string Status { get; set; } = "Pending";

    public void MarkPaid() => Status = "Paid";
}
```

**`OutboxMessage.cs`**

```csharp
public sealed class OutboxMessage
{
    public Guid Id { get; set; }
    public string EventType { get; set; } = null!;
    public int EventVersion { get; set; }
    public string Payload { get; set; } = null!;
    public DateTimeOffset OccurredAt { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public DateTimeOffset? PublishedAt { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }
    public Guid? LockToken { get; set; }
    public int Attempts { get; set; }
}
```

**`PaymentsDbContext.cs`**

```csharp
using Microsoft.EntityFrameworkCore;

public sealed class PaymentsDbContext(DbContextOptions<PaymentsDbContext> options)
    : DbContext(options)
{
    public DbSet<Payment> Payments => Set<Payment>();
    public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Payment>().HasKey(x => x.Id);

        model.Entity<OutboxMessage>(entity =>
        {
            entity.ToTable("outbox_messages");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Payload).HasColumnType("jsonb");
            entity.HasIndex(x => new { x.PublishedAt, x.NextAttemptAt });
        });
    }
}
```

> **Database naming:** All SQL in this article assumes PostgreSQL **snake_case** names. Configure `UseSnakeCaseNamingConvention()` from the `EFCore.NamingConventions` package in both services (or explicitly map every column). Generate and apply EF migrations before running the worker.

### 3.2 Save payment and event together

**`CompletePaymentHandler.cs`**

```csharp
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

public sealed class CompletePaymentHandler(PaymentsDbContext db)
{
    public async Task Handle(Guid paymentId, CancellationToken ct)
    {
        // Payment confirmation MUST be validated before this handler runs.
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // A row lock serializes competing attempts for the same payment.
        var payment = await db.Payments
            .FromSqlInterpolated($"SELECT * FROM payments WHERE id = {paymentId} FOR UPDATE")
            .SingleAsync(ct);

        if (payment.Status == "Paid")
        {
            await tx.CommitAsync(ct);
            return;
        }

        payment.MarkPaid();
        var messageId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        db.OutboxMessages.Add(new OutboxMessage
        {
            Id = messageId,
            EventType = "payments.completed",
            EventVersion = 1,
            OccurredAt = now,
            NextAttemptAt = now,
            Payload = JsonSerializer.Serialize(new
            {
                MessageId = messageId,
                PaymentId = payment.Id,
                OccurredAt = now,
                Version = 1
            })
        });

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }
}
```

**Important:** The lock SQL expects the configured snake_case naming convention. Also enforce idempotency at the payment/provider boundary: repeated payment callbacks and concurrent requests must not create multiple business events. A transaction and `FOR UPDATE` protect the example's payment row, but unique constraints and provider event IDs are also useful in real integrations.

An explicit transaction is shown for the row lock. If you don't need multiple SaveChanges calls or additional SQL, **one `SaveChangesAsync` normally already executes atomically** for the tracked payment and Outbox inserts.

## 4. Publish in the background — safely with multiple instances

The interesting part is not calling `PublishAsync`. It is ensuring **multiple workers do not claim the same pending row simultaneously**, and making crashes recoverable. PostgreSQL's `FOR UPDATE SKIP LOCKED` is useful for claiming a batch quickly.

### 4.1 Claim a batch with a durable lease

The following PostgreSQL SQL is intentionally short and illustrative. Run it as a parameterized command on an Npgsql connection and read the returned rows. Each claim uses a unique token and a lease, so that rows abandoned by a crashed worker become eligible again.

**`claim-outbox.sql`**

```sql
WITH candidates AS (
    SELECT id
    FROM outbox_messages
    WHERE published_at IS NULL
      AND next_attempt_at <= now()
      AND (locked_until IS NULL OR locked_until < now())
    ORDER BY occurred_at, id
    LIMIT @batch_size
    FOR UPDATE SKIP LOCKED
)
UPDATE outbox_messages AS o
SET lock_token = @lock_token,
    locked_until = now() + interval '2 minutes',
    attempts = attempts + 1
FROM candidates AS c
WHERE o.id = c.id
RETURNING o.id, o.event_type, o.payload, o.attempts;
```

The `SELECT ... FOR UPDATE SKIP LOCKED` and `UPDATE ... RETURNING` execute as **one database statement**, preventing two concurrent claimers from selecting the same row. Commit the claim before contacting the broker; **never hold a database transaction open during network publication**.

### 4.2 Implement the PostgreSQL store

**`PostgresOutboxStore.cs`** — this adapter implements the claim/ack/retry operations used below. The SQL is parameterized, each claim is one atomic statement, and updates only succeed for the owning lease token.

```csharp
using Npgsql;

public sealed class PostgresOutboxStore(NpgsqlDataSource dataSource) : IOutboxStore
{
    public async Task<IReadOnlyList<ClaimedOutboxMessage>> ClaimAsync(
        int batchSize, Guid lockToken, CancellationToken ct)
    {
        const string sql = """
            WITH candidates AS (
                SELECT id FROM outbox_messages
                WHERE published_at IS NULL
                  AND next_attempt_at <= now()
                  AND (locked_until IS NULL OR locked_until < now())
                ORDER BY occurred_at, id
                LIMIT @batch_size
                FOR UPDATE SKIP LOCKED
            )
            UPDATE outbox_messages AS o
            SET lock_token = @lock_token,
                locked_until = now() + interval '2 minutes',
                attempts = attempts + 1
            FROM candidates AS c WHERE o.id = c.id
            RETURNING o.id, o.event_type, o.payload::text, o.attempts;
            """;

        await using var cmd = dataSource.CreateCommand(sql);
        cmd.Parameters.AddWithValue("batch_size", batchSize);
        cmd.Parameters.AddWithValue("lock_token", lockToken);
        var claimed = new List<ClaimedOutboxMessage>();

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            claimed.Add(new ClaimedOutboxMessage(
                reader.GetGuid(0), reader.GetString(1),
                reader.GetString(2), reader.GetInt32(3)));
        return claimed;
    }

    public async Task MarkPublishedAsync(
        Guid id, Guid lockToken, CancellationToken ct)
    {
        const string sql = """
            UPDATE outbox_messages
            SET published_at = now(), lock_token = NULL, locked_until = NULL
            WHERE id = @id AND lock_token = @lock_token
              AND published_at IS NULL;
            """;
        await ExecuteAsync(sql, id, lockToken, null, ct);
    }

    public async Task ReleaseForRetryAsync(
        Guid id, Guid lockToken, TimeSpan delay, CancellationToken ct)
    {
        const string sql = """
            UPDATE outbox_messages
            SET next_attempt_at = now() + (@delay_seconds * interval '1 second'),
                lock_token = NULL, locked_until = NULL
            WHERE id = @id AND lock_token = @lock_token
              AND published_at IS NULL;
            """;
        await ExecuteAsync(sql, id, lockToken, delay, ct);
    }

    private async Task ExecuteAsync(string sql, Guid id, Guid token,
        TimeSpan? delay, CancellationToken ct)
    {
        await using var cmd = dataSource.CreateCommand(sql);
        cmd.Parameters.AddWithValue("id", id);
        cmd.Parameters.AddWithValue("lock_token", token);
        if (delay is not null)
            cmd.Parameters.AddWithValue("delay_seconds", delay.Value.TotalSeconds);
        var affected = await cmd.ExecuteNonQueryAsync(ct);
        if (affected == 0)
            throw new InvalidOperationException(
                $"Outbox lease lost for message {id}.");
    }
}
```

This adapter intentionally detects expired/stolen leases. In production, treat a failed lease update as a concurrency signal, **not as proof the broker rejected the message**. A crash after broker acknowledgment but before `MarkPublishedAsync` causes a retry and possible duplicate.

### 4.3 A worker loop with broker acknowledgment

**`OutboxPublisher.cs` (core loop)**

```csharp
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public sealed record ClaimedOutboxMessage(
    Guid Id, string EventType, string Payload, int Attempts);

public interface IOutboxStore
{
    Task<IReadOnlyList<ClaimedOutboxMessage>> ClaimAsync(
        int batchSize, Guid lockToken, CancellationToken ct);

    Task MarkPublishedAsync(
        Guid id, Guid lockToken, CancellationToken ct);

    Task ReleaseForRetryAsync(
        Guid id, Guid lockToken, TimeSpan delay, CancellationToken ct);
}

public interface IIntegrationEventBroker
{
    // Return only after the broker confirms durable acceptance.
    Task PublishAsync(
        Guid messageId, string eventType, string jsonPayload,
        CancellationToken ct);
}

public sealed class OutboxPublisher(
    IOutboxStore store,
    IIntegrationEventBroker broker,
    ILogger<OutboxPublisher> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var token = Guid.NewGuid();
            var messages = await store.ClaimAsync(20, token, stoppingToken);

            foreach (var message in messages)
            {
                try
                {
                    await broker.PublishAsync(
                        message.Id, message.EventType,
                        message.Payload, stoppingToken);

                    await store.MarkPublishedAsync(
                        message.Id, token, stoppingToken);
                }
                catch (OperationCanceledException)
                    when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex,
                        "Outbox publish failed for {MessageId}", message.Id);

                    var seconds = Math.Min(300,
                        Math.Pow(2, Math.Min(message.Attempts, 8)));

                    await store.ReleaseForRetryAsync(
                        message.Id, token,
                        TimeSpan.FromSeconds(seconds), stoppingToken);
                }
            }

            await Task.Delay(
                messages.Count == 0 ? TimeSpan.FromSeconds(2)
                                    : TimeSpan.FromMilliseconds(100),
                stoppingToken);
        }
    }
}
```

`IOutboxStore` is a **database adapter contract**, not a built-in .NET API. Implement `ClaimAsync` with the SQL above (using Npgsql parameters), and use these SQL commands for the other two operations:

```sql
-- Mark published ONLY if this worker still owns the lease.
UPDATE outbox_messages
SET published_at = now(), lock_token = NULL, locked_until = NULL
WHERE id = @id AND lock_token = @lock_token
  AND published_at IS NULL;

-- Requeue with backoff, again only while holding the lease.
UPDATE outbox_messages
SET next_attempt_at = now() + (@delay_seconds * interval '1 second'),
    lock_token = NULL, locked_until = NULL
WHERE id = @id AND lock_token = @lock_token
  AND published_at IS NULL;
```

Check the affected-row count: **zero** means the lease was lost and this worker must stop modifying that row. Keep `broker.PublishAsync` bounded by a timeout shorter than the lease, or renew the lease while publishing. Otherwise a slow publish can outlive its claim and another worker can send the same event. This remains an **at-least-once** system either way.

> **Production details:** These interfaces are intentional seams for your actual Azure Service Bus, RabbitMQ or Kafka adapter. Do not treat the broker interface above as a complete broker client implementation. Confirm acknowledgments, pass `message.Id` as a stable broker message ID, use jittered backoff, cap attempts or add a poison-message workflow, and expose lease/lag metrics.

### 4.4 Register the services

```csharp
// Program.cs (install EFCore.NamingConventions)
builder.Services.AddDbContext<PaymentsDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Payments"))
           .UseSnakeCaseNamingConvention());

builder.Services.AddNpgsqlDataSource(
    builder.Configuration.GetConnectionString("Payments")!);
builder.Services.AddSingleton<IOutboxStore, PostgresOutboxStore>();
builder.Services.AddHostedService<OutboxPublisher>();
// Register your broker-specific IIntegrationEventBroker as well.
```

`AddNpgsqlDataSource` is provided by Npgsql dependency-injection integration (install `Npgsql.DependencyInjection` if needed). Use a connection string from environment variables or a secret manager, not a checked-in secret.

## 5. Explore the workflow interactively

The walkthrough below simulates a broker outage, a retry, and consumer idempotency. It runs as **static HTML + JavaScript** with no server or framework dependency.

**[Launch the interactive Outbox workflow →](/assets/demos/outbox-workflow.html)**

The interactive workflow is intentionally opened on a separate page to avoid theme CSS and HTML-rendering conflicts.

## 6. Inbox: why the subscription must be idempotent

What if the broker accepts an event, but the worker crashes before recording `PublishedAt`? The Outbox event is retried. That is expected. The consumer must be able to see **the same message ID twice** without activating the subscription twice.

![Inbox pattern shows a duplicate PaymentCompleted event being skipped after the MessageId was recorded.](/assets/images/outbox/inbox-idempotency.png)

*Figure 3. The consumer uses an Inbox record and a unique message ID to keep repeated deliveries from repeating business effects.*

### 6.1 Persist the Inbox record and business change atomically

**`ProcessedMessage.cs`**

```csharp
public sealed class ProcessedMessage
{
    public Guid MessageId { get; set; }
    public DateTimeOffset ProcessedAt { get; set; }
}
```

Add it to your **Subscription** service's DbContext:

```csharp
public DbSet<ProcessedMessage> ProcessedMessages
    => Set<ProcessedMessage>();

// In OnModelCreating:
model.Entity<ProcessedMessage>()
    .HasKey(x => x.MessageId); // DB-enforced uniqueness
```

**`PaymentCompletedConsumer.cs`**

```csharp
using Microsoft.EntityFrameworkCore;

public sealed class PaymentCompletedConsumer(SubscriptionsDbContext db)
{
    public async Task Handle(
        Guid messageId, Guid subscriptionId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // INSERT ... ON CONFLICT avoids check-then-insert races.
        var inserted = await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO processed_messages (message_id, processed_at)
            VALUES ({messageId}, {DateTimeOffset.UtcNow})
            ON CONFLICT (message_id) DO NOTHING
            """, ct);

        if (inserted == 0)
        {
            await tx.CommitAsync(ct);
            return; // Duplicate event: already committed earlier.
        }

        var subscription = await db.Subscriptions
            .SingleAsync(x => x.Id == subscriptionId, ct);
        subscription.Activate();

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }
}
```

`SubscriptionsDbContext`, `Subscription`, and `Activate()` represent your existing domain model. In this example, the inbox and subscription update share **the same PostgreSQL database transaction**. If activation fails, the transaction rolls back the Inbox insert too, so the broker can retry. A broker acknowledgment should be sent **only after commit**. If a message initiates external side effects (email, third-party billing), use another durable mechanism for those effects rather than assuming this local transaction covers them.

**Important mapping detail:** This SQL assumes the same snake_case naming convention as the publisher. Also validate the event schema and map `PaymentId` to the intended subscription explicitly; do not assume their IDs are interchangeable.

## 7. Production checklist

Use this as a release-review checklist, not a guarantee supplied automatically by the pattern.

- [ ] Payment confirmation is idempotent and authenticated against the payment provider.
- [ ] Payment and Outbox rows commit in **one transaction**.
- [ ] Outbox events have stable IDs, type/version and occurrence timestamp.
- [ ] Concurrent publishers claim work using `SKIP LOCKED` or an equivalent safe mechanism.
- [ ] Leases recover abandoned work after process crashes; timeouts and renewals are defined.
- [ ] Messages are marked published **after broker acknowledgment**.
- [ ] Exponential backoff, jitter, poison-message handling and alerting are configured.
- [ ] Inbox message IDs have a database-backed unique constraint.
- [ ] Inbox state and consumer business change commit atomically.
- [ ] Monitor oldest pending age, retry count, worker failures, and delivery lag.
- [ ] Plan cleanup/retention, replay, contract evolution, and ordering requirements.

### Ordering and scale

At-least-once delivery does **not** imply ordering. For dependent events (`PaymentCreated`, `PaymentCompleted`, `PaymentRefunded`), consider per-aggregate sequence numbers and partition keys. Do not assume a global `ORDER BY occurred_at` produces strict delivery order with multiple workers. If order is essential, enforce it separately at the publisher and/or consumer.

### What should you alert on?

| Signal | Meaning |
|---|---|
| Oldest unpublished message age | How far event publication is behind |
| Retry attempts / poison messages | Persistent broker or serialization failures |
| Claim lease expiry rate | Workers crash or exceed the lease duration |
| Consumer duplicate count | Expected redelivery volume or abnormal retries |
| Inbox processing failures | Business handler or database failures |

## 8. When to use the Outbox — and when not to

**Use it** when a local state change **must eventually produce an integration event**, especially for payments, orders, inventory and fulfillment workflows.

**Reconsider it** when losing the event is tolerable, you already have a database change-data-capture pipeline with equivalent guarantees, or the extra table, publisher, monitoring and operational maintenance outweigh the risk. CDC can also be used to **relay the outbox table**; it does not remove the need for atomic business + outbox persistence.

The pattern trades **operational simplicity** for **reliability and eventual consistency**. Consumers might receive events late or more than once. Design for both.

## 9. Key takeaways

1. A database write and a broker publish are two independent operations; naïvely combining them creates failure windows.
2. The Outbox persists business state and a pending event together, using one local transaction.
3. A worker publishes pending events asynchronously, and retries until acknowledged or escalated.
4. **Duplicates are normal.** The Inbox pattern and idempotent handlers prevent repeated business effects.
5. Production correctness includes claiming, leases, observability, ordering decisions, schema evolution, and cleanup.

**Interview question:** Your broker accepted `PaymentCompleted`, but your publisher crashed before marking the Outbox row complete. What happens next, and how do you prevent duplicate subscription activation?

If you can explain that failure window clearly, you understand the reason the Outbox and Inbox patterns exist.

**Continue learning:** [Explore more engineering articles](/posts/) · [Watch .NET architecture tips on YouTube](https://www.youtube.com/@GaribTigranyan)

---

*References: [Statiq Web content files](https://www.statiq.dev/guide/web/content-files/), [PostgreSQL locking clauses](https://www.postgresql.org/docs/current/sql-select.html), [EF Core transactions](https://learn.microsoft.com/en-us/ef/core/saving/transactions), [Microservices transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html).*
