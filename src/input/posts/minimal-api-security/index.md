---
Title: "Secure Your .NET Minimal API: Five Layers Before Production"
Description: "Build safer Minimal APIs with JWT validation, permissions, input checks, rate limits, ownership rules, and deliberate CORS configuration."
Category: "SECURITY"
ReadingTime: "12 min read"
Date: 2026-11-08
Layout: /_PostLayout.cshtml
Tags:
  - dotnet
  - csharp
  - minimal-api
  - api-security
  - authorization
  - rate-limiting
Image: "/assets/images/minimal-api-security/thumbnail.webp"
---

*Your Orders API returns the right data. But can Alice change an ID and read Bob's order?*

A valid token is only the beginning. A production API also needs to reject invalid input, limit expensive work, and decide which records each caller can access.

This guide follows one **ASP.NET Core Minimal API in .NET 10** through five practical layers. Each layer answers a different question. Together, they give us a useful starting boundary, not a complete security audit.

<figure>
  <img src="/assets/images/minimal-api-security/thumbnail.webp" alt="Garib Tigranyan presenting five security layers for a .NET Minimal API" width="1920" height="1080" style="display:block;max-width:100%;height:auto;border-radius:12px" decoding="async" />
  <figcaption>Protect the route, validate the request, limit traffic, scope the data, and configure browser access deliberately.</figcaption>
</figure>

**[Open the animated five-layer overview →](/assets/demos/minimal-api-security-layers.html)**

The overview matches the companion video and runs locally in your browser. The article below supplies the implementation details behind those labels.

## What we are building

Our API serves an Orders application. It receives access tokens in the `Authorization: Bearer` header from one trusted identity provider.

- **Protect routes:** Is the caller authenticated and allowed to perform this action?
- **Validate input:** Is the request well formed, and does it satisfy our business rules?
- **Limit traffic:** How much work may this caller ask us to perform?
- **Scope data:** Does this particular order belong to the caller or an authorized tenant?
- **Configure browser access:** Which browser origins need to read our API responses?

The C# examples are integration excerpts for an existing application. They assume `AppDb` is your EF Core context and an order has `Id`, `UserId`, `ProductId`, and `Quantity`. Adapt these names to your domain; do not add a second database setup just to use the examples.

Target `net10.0` and reference compatible **10.0 servicing versions** of `Microsoft.AspNetCore.Authentication.JwtBearer` and `Microsoft.Extensions.Validation`. Keep your existing EF Core provider. Pin and update actual package versions through your application's normal dependency process.

## Layer 1: protect routes and validate identity

Start with configuration that belongs to your trusted identity provider:

```json
{
  "Auth": {
    "Authority": "https://identity.example.com/",
    "Audience": "orders-api"
  }
}
```

Replace both example values. `Authority` identifies your trusted issuer and its metadata; `Audience` identifies this API. These identifiers are not client secrets. A token issued for a different API must not be accepted here.

### Register authentication and permission policies

The token contract in this example uses a nonempty `sub` claim for the caller and a space-separated `scope` claim for permissions. If your provider uses `scp` or roles, change the policy to match that contract.

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;

var builder = WebApplication.CreateBuilder(args);

var authority = builder.Configuration["Auth:Authority"];
var audience = builder.Configuration["Auth:Audience"];
if (string.IsNullOrWhiteSpace(authority) ||
    string.IsNullOrWhiteSpace(audience))
{
    throw new InvalidOperationException(
        "Configure Auth:Authority and Auth:Audience.");
}

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = authority;
        options.Audience = audience;
        options.MapInboundClaims = false;
        options.RequireHttpsMetadata = true;
    });

builder.Services.AddAuthorization(options =>
{
    var signedIn = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .RequireAssertion(context =>
            !string.IsNullOrWhiteSpace(
                context.User.FindFirstValue("sub")))
        .Build();

    options.DefaultPolicy = signedIn;
    options.FallbackPolicy = signedIn;

    options.AddPolicy("OrdersRead", policy => policy
        .Combine(signedIn)
        .RequireAssertion(context =>
            HasScope(context.User, "orders:read")));

    options.AddPolicy("OrdersWrite", policy => policy
        .Combine(signedIn)
        .RequireAssertion(context =>
            HasScope(context.User, "orders:write")));
});
```

Add this helper as a local function in `Program.cs`, after the top-level statements:

```csharp
static bool HasScope(ClaimsPrincipal user, string requiredScope) =>
    user.FindAll("scope")
        .SelectMany(claim => claim.Value.Split(
            ' ', StringSplitOptions.RemoveEmptyEntries))
        .Contains(requiredScope, StringComparer.Ordinal);
```

`MapInboundClaims = false` keeps the subject claim named `sub`. Splitting `scope` matters: a claim containing `orders:read orders:write` is not the same string as `orders:read`.

The bearer handler validates the token's signature, issuer, audience, and lifetime. **Decoding a JWT is not validation.** The frontend's ID token is also not a substitute for an access token intended for this API.

### Apply protection to a route group

After building the app and adding the middleware shown later, map the protected group:

```csharp
var orders = app.MapGroup("/api/orders")
    .RequireAuthorization()
    .RequireRateLimiting("orders");

orders.MapGet("/{id:guid}", GetOrder)
    .RequireAuthorization("OrdersRead");

orders.MapPost("/", CreateOrder)
    .RequireAuthorization("OrdersWrite");
```

The named limiter is registered in layer 3. `GetOrder` appears in layer 4; `CreateOrder` is your existing business handler, with its required behavior described below.

New child endpoints inherit the group's authorization requirement. The fallback policy protects endpoints without their own authorization metadata. Explicit named policies must include the identity requirements they need; this is why our read and write policies combine `signedIn`.

Use `.AllowAnonymous()` only for intentionally public endpoints. It bypasses authorization, even if the group requires it.

**Expected outcomes:** missing or invalid credentials produce `401`; a signed-in caller who fails a permission policy receives `403`.

## Layer 2: validate input before doing business work

Register .NET 10 Minimal API validation before `builder.Build()`:

```csharp
builder.Services.AddValidation();
builder.Services.AddProblemDetails();
```

Use a request type that contains only fields the client is allowed to choose:

```csharp
using System.ComponentModel.DataAnnotations;

public sealed class CreateOrderDto
{
    [Required, StringLength(64)]
    public string ProductId { get; init; } = "";

    [Range(1, 100)]
    public int Quantity { get; init; }
}

public sealed record OrderDto(
    Guid Id,
    string ProductId,
    int Quantity);
```

With `CreateOrderDto` bound to the POST body, quantity `-5` fails automatic validation and returns `400` before the handler runs. The annotations alone are not the whole setup: include the validation package and registration.

Notice what is missing: `UserId`, `TenantId`, `Price`, `Total`, and administrative flags. Do not bind a persistence entity and let the client assign those fields.

Your `CreateOrder` handler still needs to:

- Resolve the owner from the validated identity and any authorized tenant context.
- Load the current product and price on the server.
- Check stock and other business rules.
- Save related changes with deliberate transaction and concurrency handling.
- Return a response DTO, normally with `201 Created` and the new resource's location.

**Validation checks the request, not the caller's right to perform it.** It also does not replace parameterized database queries or prevent concurrent requests from overselling stock.

## Layer 3: put a budget on traffic

Rate limits help protect capacity and reduce abuse. Register an endpoint policy before building the app:

```csharp
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode =
        StatusCodes.Status429TooManyRequests;

    options.AddPolicy("orders", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            context.User.FindFirstValue("sub")!,
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                AutoReplenishment = true
            }));
});
```

The group already attaches this policy with `.RequireRateLimiting("orders")`. The example permits 30 requests per subject per fixed window and does not queue excess work. Rejections use `429`.

The `sub` is safe to require here because our authorization policies reject missing subjects and authorization runs before this limiter. Do not copy that assumption into an anonymous endpoint.

**Choose your own budget.** Thirty requests is an illustration, not a recommended limit for every endpoint. A costly export and a small read should not necessarily receive the same allowance.

These counters are **per application instance**. Three servers do not share one 30-request budget. Put additional controls at the gateway when you need a shared budget, anonymous-traffic limits, or protection for authentication work. Fixed windows also permit bursts around a window boundary; they do not guarantee evenly spaced requests.

## Layer 4: check access to the actual record

An `orders:read` permission allows an action. It does not prove that every order belongs to that caller.

Constrain the database lookup using the trusted identity:

```csharp
using Microsoft.EntityFrameworkCore;

static async Task<IResult> GetOrder(
    Guid id,
    ClaimsPrincipal user,
    AppDb db,
    CancellationToken ct)
{
    var subject = user.FindFirstValue("sub");
    if (string.IsNullOrWhiteSpace(subject))
        return Results.Forbid();

    var order = await db.Orders
        .AsNoTracking()
        .Where(o => o.Id == id && o.UserId == subject)
        .Select(o => new OrderDto(
            o.Id, o.ProductId, o.Quantity))
        .SingleOrDefaultAsync(ct);

    return order is null
        ? Results.NotFound()
        : Results.Ok(order);
}
```

Move all `using` directives to the top of the actual source file. Keep your existing `AppDb` registration and database provider.

If Alice requests Bob's ID, the query finds no authorized row. Returning `404` for both a missing row and an unauthorized row avoids directly disclosing existence through different status codes.

For a multi-tenant application, include the authorized tenant boundary too. Resolve that tenant through trusted identity and membership rules; never trust an arbitrary `TenantId` supplied by the request. This example trusts one issuer. If you accept several issuers, a `sub` alone is not globally unique: use an issuer-and-subject identity key.

Apply the same boundary to lists, updates, deletes, exports, and related records. If permissions include delegation or resource state, use a resource-authorization handler that implements those rules.

For more detail, read [Authentication Is Not Ownership](/posts/authorization-vs-ownership/).

## Layer 5: configure browser access and middleware order

If the frontend is on another origin, allow the exact origin it uses:

```csharp
builder.Services.AddCors(options =>
    options.AddPolicy("frontend", policy => policy
        .WithOrigins("https://app.example.com")
        .WithMethods("GET", "POST")
        .WithHeaders("Authorization", "Content-Type")));
```

Use the real scheme, hostname, and port. Allow only methods and headers the browser application needs. If your application has no cross-origin browser client, do not enable CORS merely to complete a checklist.

This example uses bearer headers, not credentialed cookies. Cookie authentication needs separate decisions about credentials, cookie settings, and CSRF protection.

Put the middleware together explicitly:

```csharp
// All service registrations above this line.
// Keep your AppDb and business-service registrations too.
var app = builder.Build();

app.UseExceptionHandler();
app.UseHttpsRedirection();
app.UseRouting();
app.UseCors("frontend");
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

// Map the protected Orders group from layer 1 here.
app.Run();
```

CORS runs before authorization so preflight can receive the right headers. Authentication establishes the identity, authorization checks the route policies, and this endpoint limiter uses the authorized subject. Request validation and the ownership query run during endpoint processing.

**These are conceptual layers, not five interchangeable middleware stages.** Ownership belongs at the resource boundary; request validation happens when the endpoint's input is processed.

**CORS is not authorization.** It lets servers opt into cross-origin browser access; it does not stop curl or make a public endpoint private. A disallowed origin commonly gets no allow-origin header rather than a server-side `403`. The browser may block reading a response even though the server has already handled the request.

Clients should call HTTPS directly. Configure trusted proxies and forwarded headers correctly at your ingress; do not assume a redirect is the complete transport-security setup.

## Verify the boundaries before shipping

Use integration tests with known users, known orders, and a fresh rate budget. Change one condition at a time:

- **No token or expired token:** `401`.
- **Valid token without the required action permission:** `403`.
- **Valid writer with quantity `-5`:** `400`, with no order created.
- **Valid caller above the configured rate budget:** `429`.
- **Alice requests Bob's order:** `404`, with no order details returned.
- **Alice requests her own order:** `200`, with only the allowed response fields.
- **Allowed browser preflight:** the intended CORS headers are present.
- **Disallowed origin:** the response has no allow-origin grant for that origin.

If the bearer handler uses a lifetime clock-skew allowance, account for it when testing expired tokens. Do not let earlier rate-limit tests consume the budget for later tests. Also verify writes cause no forbidden side effects, not just the returned status.

## What still belongs on the production checklist

These five layers do not replace TLS and proxy configuration, protected secrets, safe error responses, request-size limits, dependency updates, database permissions, or monitoring. Keep access tokens and sensitive request values out of security logs. Add application-specific threat modeling and test the actual deployment boundary.

The useful habit is to ask different questions at different boundaries: **who is calling, what may they do, which records may they touch, and how much work may they ask for?**

## References and next steps

- [Minimal API security](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security?view=aspnetcore-10.0)
- [Configure JWT bearer authentication](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication?view=aspnetcore-10.0)
- [Minimal API validation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validation-support-in-minimal-apis)
- [ASP.NET Core rate limiting](https://learn.microsoft.com/en-us/aspnet/core/performance/rate-limit?view=aspnetcore-10.0)
- [Resource-based authorization](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/resourcebased?view=aspnetcore-10.0)
- [CORS](https://learn.microsoft.com/en-us/aspnet/core/security/cors?view=aspnetcore-10.0)

**Continue learning:** [Browse all articles](/blog/) or [watch my .NET walkthroughs on YouTube](https://www.youtube.com/@GaribTigranyan).
