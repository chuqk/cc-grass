# Pricing maintenance

The CLI is offline. Its bundled table remains the source for verified historical
price periods. `--pricing-file <path>` optionally loads an additional catalog.

From a source checkout, after `npm run build`:

```bash
node scripts/sync-pricing.mjs
node dist/cli.js --html --pricing-file ~/.cache/cc-grass/pricing.json -o index.html
```

Pass a path as the first argument to the helper to select another catalog.
On Windows its default is `%LOCALAPPDATA%\cc-grass\Cache\pricing.json`.
The local Pages update script runs this helper before rendering; its existing
10-minute bashboard schedule is unchanged. No scheduler or push logic is added
to the CLI or npm package.

The helper uses the existing incremental scan cache to collect model IDs, then
fetches only these primary sources:

- https://platform.claude.com/docs/en/about-claude/pricing.md
- https://developers.openai.com/api/docs/pricing.md

It checks daily and immediately when a previously unseen model ID appears.
Failed requests retry after one hour. Each request has a 15-second timeout.
No session content, paths, or usage data are sent to either vendor.
Parsing is deterministic, with explicit column validation: only Standard,
short-context prices are accepted. Batch/Flex/Fast rates are never substituted.

New models found in local logs are registered automatically, including explicit
cache prices. The first row's `from` is the **observation date**, not an inferred
launch date. The existing preview fallback uses that first verified price for
earlier usage. Models already covered by the bundled table retain its periods.
Network or document-format failures preserve the last verified catalog; writes
are validated and atomically renamed. A malformed catalog is never overwritten.

The local JSON also records `checkedAt`, `attemptedAt`, `errors`, `unresolved`,
and `priceChanges`. Models absent from the official tables (for example an
internal `codex-auto-review` ID) keep `price n/a`; a family price is not guessed.
An existing model's changed rate is recorded under `priceChanges`, since a
current table does not establish its effective date. Verify that date in official
release notes or an archived official page, then append a price period to
`src/pricing.ts` (or the explicit catalog), closing the preceding period. Never
replace an existing price in place. The sync helper does not apply these changes
automatically or send notifications.

The tests use synthetic future model IDs to verify automatic registration,
Standard/Batch separation, cache-rate handling, failed-request retention,
retry timing, offline catalog validation, and unchanged historical prices.
Their bundled-model fixture is explicitly a dated snapshot, not a claim to cover
every model appearing in future logs.
