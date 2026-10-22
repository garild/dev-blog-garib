# Outbox article drop-in bundle for Statiq Web

## Copy paths

- `index.md` -> `src/input/posts/outbox-pattern/index.md` (or your existing article's actual input path)
- `assets/images/outbox/*.png` -> `src/input/assets/images/outbox/*.png`
- `assets/demos/outbox-workflow.html` -> `src/input/assets/demos/outbox-workflow.html`

The Markdown uses root-relative URLs like `/assets/images/outbox/failure-scenario.png`, expecting those files to be copied to `src/output/assets/...` at build time.

If your custom Statiq pipeline does not copy static non-Markdown assets, add an asset copy step or copy the assets to the published output in CI. Verify the built `/assets/...` URLs (status 200).

## Dependencies and scope

Code excerpts are implementation building blocks, not a complete buildable sample repository. They intentionally reference your domain types and require a concrete `IOutboxStore` (Npgsql SQL adapter) and `IIntegrationEventBroker` (Azure Service Bus/RabbitMQ/Kafka adapter). Recommended packages: `Microsoft.EntityFrameworkCore`, `Npgsql.EntityFrameworkCore.PostgreSQL`, `Npgsql`; optionally `EFCore.NamingConventions` for snake_case naming. Add hosted worker registration and appropriate application configuration.

Test the SQL under the exact EF migration naming convention you use. All SQL snippets assume snake_case EF mappings using `UseSnakeCaseNamingConvention()` in both services.

`iframe` requires HTML passthrough from your Markdown pipeline; if unsupported, replace the iframe with a regular link to the provided demo page. CSP must permit the same-origin frame; sandbox `allow-scripts` is already set.

## Check before publishing

1. Generate the Statiq site.
2. Verify article output location and navigation.
3. Verify three images and HTML demo load at their root-relative paths.
4. Check diagram text legibility on mobile and provide captions/alt text.
5. Apply EF migrations and test failure/retry/duplicate scenarios in a sample application before considering the snippets production-ready.
6. Confirm your theme consumes `Image`, `Tags`, and `ReadingTime` metadata; those fields do not automatically guarantee Open Graph output.

Article published date is set to 2026-10-22. Change it if deploying on another date.
