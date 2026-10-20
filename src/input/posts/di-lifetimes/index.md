---
Title: "DI Lifetimes: Beyond Transient, Scoped & Singleton"
Description: "How DI scope boundaries, captive dependencies, and incorrect lifetimes can cause subtle production bugs."
Category: ".NET / C#"
ReadingTime: "6 min read"
Date: 2026-10-19
Layout: /_PostLayout.cshtml
---

## Lifetime is a correctness decision

The three built-in lifetimes in ASP.NET Core are easy to memorize: transient creates instances on resolution, scoped creates one instance per scope, and singleton shares an instance from the application container. The hard part is **matching the lifetime to the work**.

| Lifetime | Typical fit | Watch out for |
| --- | --- | --- |
| Transient | Stateless lightweight components | Extra allocations or captured disposables |
| Scoped | Request-oriented services, EF Core `DbContext` | Using them from root-container singletons |
| Singleton | Shared configuration or stateless thread-safe helpers | Shared mutable state and captive dependencies |

## The captive dependency trap

Avoid injecting a scoped `DbContext` into a singleton. A singleton can outlive the request scope that owns the context, creating lifetime and concurrency problems.

```csharp
// Avoid: a singleton depends on a scoped service.
builder.Services.AddDbContext<AppDbContext>();
builder.Services.AddSingleton<OrderCache>();

public sealed class OrderCache(AppDbContext db)
{
    // The DbContext belongs to a request scope.
}
```

A common resolution is to make the consuming service scoped as well:

```csharp
builder.Services.AddDbContext<AppDbContext>();
builder.Services.AddScoped<OrderReader>();

public sealed class OrderReader(AppDbContext db)
{
    public Task<Order?> FindAsync(Guid id, CancellationToken ct) =>
        db.Orders.SingleOrDefaultAsync(x => x.Id == id, ct);
}
```

The example assumes EF Core and an `Order` entity. For a singleton background worker, create a scope for each work unit through `IServiceScopeFactory`, or use a suitable context factory.

## Validate the registrations

```csharp
builder.Host.UseDefaultServiceProvider((context, options) =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

These checks catch many invalid dependency graphs early. They are helpful but **not a substitute for checking thread safety and ownership**.

## A practical decision checklist

1. Who owns this service, and when should it be disposed?
2. Does the service keep mutable state?
3. Does any dependency have a shorter lifetime?
4. Will this instance run concurrently across requests?
5. Could an object be held much longer than intended?

The best lifetime is the one that matches your service's *actual boundaries*, not the one that saves the most registrations.
