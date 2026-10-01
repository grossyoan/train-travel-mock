# Train Travel API mock

**Live:** https://train-travel-mock.train-travel-mock.workers.dev

A stateful mock of the [Train Travel API](https://bump.sh/bump-examples/doc/train-travel-api), running for free on Cloudflare Workers. You can run the whole booking flow end to end, and every id returned by one call works in the next:

```
GET /stations → GET /trips → POST /bookings → POST /bookings/{id}/payment → GET /bookings/{id} → DELETE /bookings/{id}
```

## Deploy

You need Node 22 or later (`nvm use` reads `.nvmrc`) and a free Cloudflare account.

```sh
npm install
npx wrangler login      # opens the browser once
npm run deploy          # prints https://train-travel-mock.<your-subdomain>.workers.dev
npm run smoke -- https://train-travel-mock.<your-subdomain>.workers.dev
```

Then replace `YOUR-SUBDOMAIN` in the `servers` entry of `openapi.yaml` and publish the spec.

## How it behaves

**Authentication is optional.** No token is issued or checked.
- Any `Authorization` header value (`Bearer anything`) opens a private data space for that value. The value is hashed and never stored in clear.
- Without the header, you share the public space.
- A space is wiped after 24 hours without activity, and keeps the 200 most recent bookings.

**Inputs are lenient, the contract is not.**
- Missing or mistyped `required` fields return a `400 application/problem+json`. Its `detail` names each field, and `errors[]` points at each one (`/passenger_name`, `/source/cvc`, …).
- Unknown fields are ignored.
- Dates can be `2026-11-02` or any ISO 8601 date-time.
- Booleans accept `true`/`1`/`yes`.
- Card numbers can contain spaces or dashes.
- `page` and `limit` are clamped instead of rejected.

**Data feels real.**
- **Stations**: 43 real European stations, filterable by `search` (case and accent insensitive), `country` and `coordinates` (sorted by distance).
- **Trips**: a deterministic timetable for each origin, destination and day. The same search always returns the same trips. Price, duration and operator follow the real distance. `bicycles=true` and `dogs=true` really filter. Unknown station ids still get trips.
- **Bookings**:
  - you can only book a trip you have searched (`404` otherwise);
  - booking a bicycle or a dog on a trip that does not allow it returns `409`;
  - creating a booking returns `201` with a `Location` header.
- **Payments**:
  - the card or account number is masked to its last 4 digits;
  - `cvc` and `address_line*` are never returned;
  - `amount` and `currency` default to the trip fare;
  - paying an already paid booking replays the payment instead of charging twice.
- **Live updates**: `SUBSCRIBE /trips/{id}` streams a platform change, an optional delay, the departure and the arrival, as JSON Lines (default) or Server-Sent Events (`Accept: text/event-stream`). `?interval=<seconds>` sets the pace (default 2, maximum 10, `0` for instant).
- **XML**: send `Accept: application/xml` for XML responses, or `Content-Type: application/xml` to send an XML booking.

**Test cards**

| Number | Result |
| --- | --- |
| `4242424242424242` (or any other) | `status: succeeded` |
| `4000000000000002` | `status: failed` (declined) |
| `4000000000009995` | `status: failed` (insufficient funds) |

**Errors on demand.** Use `Prefer: code=429`, as Prism does, or `?__code=429` to get any status the spec documents for that operation, with the spec's example error body. `429` also sets `Retry-After`. Use `?__code=` when you cannot set headers, for example behind a CORS proxy.

**Extras not in the spec.**
- `GET /` lists the endpoints.
- `GET /stations/{id}` and `GET /trips/{id}` exist so that the `links` in responses can be followed.

## Known limits

- **API Explorer on Bump.sh**: its CORS proxy only forwards `GET, POST, PUT, PATCH, DELETE, OPTIONS`, so `QUERY /stations` and `SUBSCRIBE /trips/{id}` need curl or a direct call. The mock itself sends CORS headers for every method.
- **Webhooks**: the `newBooking` webhook is not sent, because the spec has no way to register a callback URL.
- **Payment status codes**: `POST /bookings/{id}/payment` returns `404` for an unknown booking, although the spec does not list `404` for that operation.
- **Rate limiting**: the `RateLimit` header is informational only; the mock never throttles. Cloudflare's free plan allows 100,000 requests a day.

## Develop

```sh
npm run dev         # http://localhost:8787
npm test            # unit, flow and contract tests in the Workers runtime
npm run typecheck
npm run lint
```

`test/contract.test.ts` validates every response against the schemas in `openapi.yaml` (OpenAPI 3.2, with formats asserted), and checks that `src/http/operations.ts` lists the same status codes as the spec. When the spec changes, these tests show what to update.

| Path | Role |
| --- | --- |
| `src/domain/` | Pure logic: stations, trips, payments, validation, seeded random |
| `src/http/` | Content negotiation, Problem responses, pagination, `Prefer` handling |
| `src/routes/` | One Hono router per resource |
| `src/store/space.ts` | The Durable Object (SQLite) holding one data space |
