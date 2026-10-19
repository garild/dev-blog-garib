---
Title: "Authentication Is Not Ownership"
Description: "A valid JWT and a permission check do not prove that the caller is allowed to access a particular order."
Category: "SECURITY"
ReadingTime: "5 min read"
Date: 2026-10-18
Layout: /_PostLayout.cshtml
---

## The two green checks

Alice signs in and gets a valid access token. She has the permission `orders.read`. The API checks both and looks up the requested order by its ID.

```csharp
[Authorize]
[HttpGet("{id:guid}")]
public async Task<IActionResult> Get(Guid id)
{
    var order = await db.Orders.FindAsync(id);
    return order is null ? NotFound() : Ok(order);
}
```

This endpoint authenticates Alice but never checks whether the order belongs to her. If she replaces the ID in the URL with Bob's, the controller could expose Bob's order. This is a form of **Broken Object Level Authorization (BOLA)**, also commonly called IDOR.

## Option 1: constrain the query

When ownership is straightforward, filter by both resource ID and the trusted user or tenant context.

```csharp
var userId = User.FindFirst("sub")?.Value;
if (userId is null) return Unauthorized();

var order = await db.Orders
    .AsNoTracking()
    .SingleOrDefaultAsync(x => x.Id == id && x.OwnerId == userId);

return order is null ? NotFound() : Ok(order);
```

Use a trustworthy identity claim issued by your identity provider and map it consistently to your domain. Do not accept `OwnerId` from client input as an authorization proof.

## Option 2: resource authorization

When permissions depend on ownership, delegation, organization membership or order status, resource-based authorization can express these business rules clearly.

```csharp
var order = await db.Orders.FindAsync(id);
if (order is null) return NotFound();

var result = await authorizationService.AuthorizeAsync(
    User, order, "CanReadOrder");

if (!result.Succeeded) return Forbid();
return Ok(order);
```

Your `CanReadOrder` handler must implement the real access rules. Simply naming a policy does not make it secure.

## Production checklist

1. Authenticate the caller.
2. Check the requested action and the specific resource.
3. Apply tenant constraints consistently across reads and writes.
4. Test with Alice trying to access Bob's data.
5. Keep access-denied behavior and logs privacy-conscious.

**The key principle:** knowing *who* a caller is and *what* actions they can perform does not answer *which specific resources* they may access.
