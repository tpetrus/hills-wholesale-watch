# hills-wholesale-watch

Cloudflare Worker that checks https://wholesalegaming.com/pokemon/ hourly,
8am-6pm Eastern time, and pushes an [Pushover](https://pushover.net) notification
when a product is added, removed, or has a price change. Availability and
quantity-code fluctuations are ignored — too noisy to be worth a
notification.

The cron trigger fires every hour from 12:00-23:00 UTC (Cloudflare crons
can't express a timezone and don't observe DST), which covers 8am-6pm in
both EST and EDT. The scheduled handler checks the actual Eastern-time hour
and skips the run outside 8am-6pm, so the one extra UTC hour needed to
cover the DST-shifted window is a no-op instead of an out-of-hours check.

The page is old nested-table HTML with no classes/ids, but every product's
"Add to Cart" button carries an inline `add2cart('sku^name^price^...')` call
that gives structured data directly — see `parseCatalog` in `src/index.ts`.

## Subscribe to notifications

Install the [Pushover app](https://pushover.net) (iOS/Android) and log in.
The worker needs two secrets, set with `wrangler secret put`:

- `PUSHOVER_USER_KEY` — your user key (shown on the Pushover dashboard).
- `PUSHOVER_APPLICATION_TOKEN` — the API token of a Pushover application
  you create for this worker.
- `PUSHOVER_ERROR_APPLICATION_TOKEN` — token of a second Pushover
  application used only for error notifications (failed fetch, page parsed
  to 0 products, unexpected exceptions).

Pushover messages are capped at 1024 characters, so long change lists are
truncated with a total-changes count.

## Develop

```
npm install
npm run dev      # local dev server
npm run deploy   # deploy to Cloudflare
npm run tail     # stream logs from the deployed worker
```

## Endpoints

- `GET /` — status: last check time + product count.
- `GET /run` — manually trigger a check (same logic as the cron).
- `GET /test` — send one test notification through each Pushover app
  (main and error).

## Storage

A single JSON blob (`latest`) in the `SNAPSHOTS` KV namespace holds the most
recent catalog snapshot. First run stores a baseline and sends a "watch
started" notification instead of a diff.
