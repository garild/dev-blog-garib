---
Title: "Liveness vs Readiness: Avoid the Restart Storm"
Description: "Health checks should distinguish a process that must restart from one that should temporarily stop receiving traffic."
Category: "DEVOPS"
ReadingTime: "5 min read"
Date: 2026-10-16
Layout: /_PostLayout.cshtml
---

## Health is not one Boolean

A database outage can make an API unable to serve requests even when its process is perfectly alive. If Kubernetes uses the same dependency-heavy check for **liveness**, it may restart healthy pods during a shared outage.

The difference matters:

- **Liveness:** should Kubernetes restart this process?
- **Readiness:** should this pod receive traffic now?
- **Startup:** has the application finished starting up?

## Separate the ASP.NET Core endpoints

```csharp
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(),
        tags: ["live"])
    // Register dependency checks with the ready tag.
    ;

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("live")
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => !check.Tags.Contains("live")
});
```

The example illustrates filtering only: add real readiness checks for critical dependencies if your application needs them. The readiness route must reflect the operational requirements of your service.

## A common mistake

Avoid including transient database or message-broker failures in the liveness check by default. When an entire cluster loses access to a shared database, restarting every pod may increase load and prolong recovery.

## What I measure

Track probe failures alongside restart counts, deployment rollouts, dependency latency, and request success rates. Add a startup probe for slow initialization when appropriate.

A good health check answers one clear operational question. Combining them carelessly turns a small dependency issue into a platform incident.
