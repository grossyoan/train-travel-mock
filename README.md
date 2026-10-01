# Train Travel API mock

**Live:** https://train-travel-mock.train-travel-mock.workers.dev

A stateful mock of the [Train Travel API](https://bump.sh/bump-examples/doc/train-travel-api), running for free on Cloudflare Workers. You book a ticket the way a traveller would, and every id returned by one call works in the next:

```
GET  /trips?origin=Paris&destination=Berlin   next departures, times in UTC
POST /bookings                                held for 60 minutes: status pending_payment
POST /bookings/{id}/payment                   card or bank account
GET  /bookings/{id}                           status confirmed
SUBSCRIBE /trips/{id}                         live platform, delay, departure and arrival
```

## Deploy

You need Node 22 or later (`nvm use` reads `.nvmrc`) and a free Cloudflare account.

```sh
npm install
npx wrangler login      # opens the browser once
npm run deploy          # prints https://train-travel-mock.<your-subdomain>.workers.dev
npm run smoke -- https://train-travel-mock.<your-subdomain>.workers.dev
```

Then set the mock's URL in the `servers` entry of `openapi.yaml` and publish the spec. `npm test` checks that each example in `openapi.yaml` matches its schema, and that the mock returns no property the spec does not describe.

## How it behaves

**Authentication is optional.** No token is issued or checked.
- Any `Authorization` header value (`Bearer anything`) opens a private data space for that value. The value is hashed and never stored in clear.
- Without the header, you share the public space.
- A space is wiped after 24 hours without activity, and keeps the 200 most recent bookings.

**Inputs are lenient, the contract is not.**
- Missing or mistyped `required` fields return a `400 application/problem+json` whose `detail` names each field.
- One deliberate exception: a card's `cvc` is optional. The Bump.sh API Explorer hides `writeOnly` fields from request forms, so cards paid from the Explorer arrive without it. A `cvc` that is sent is still validated.
- Unknown fields are ignored.
- `origin` and `destination` take a station id or a name (`Paris`, `Berlin Hbf`, `zurich`); a name resolves to the city's main station. An unknown name returns a `400` that says so.
- `date` is optional (default: now). A date alone (`2026-11-02`) or a date-time without offset (`2026-11-02T09:00`) is read in the origin station's timezone; an explicit offset or `Z` is taken as is.
- Booleans accept `true`/`1`/`yes`.
- Card numbers can contain spaces or dashes.
- `page` and `limit` are clamped instead of rejected.

**Data feels real.**
- **Stations**: 43 real European stations, filterable by `search` (case and accent insensitive), `country` and `coordinates` (sorted by distance).
- **Trips**: a deterministic timetable for each origin, destination and local day, from 05:00 to 22:00 station time. The same search always returns the same trips. Times are returned in UTC, as in the spec's examples (`2024-02-01T10:00:00Z`). Price, duration and operator follow the real distance. `bicycles=true` and `dogs=true` really filter.
- **Bookings** follow a real lifecycle:
  - you can only book a trip you have searched (`404` otherwise), and not one that has already departed (`409`);
  - booking a bicycle or a dog on a trip that does not allow it returns `409`;
  - a new booking is `pending_payment`, with its `price`, `currency` and `expires_at` (a 60-minute hold), and a `links.self`;
  - after a successful payment it is `confirmed`;
  - `GET /bookings` lists plain bookings, without `links`, as the spec describes them;
  - unpaid past its hold, it becomes `expired` and payment returns `409`.
- **Payments**:
  - the card or account number is masked to its last 4 digits;
  - `cvc` and `address_line*` are never returned;
  - `amount` and `currency` default to the booking's fare;
  - a failed payment leaves the booking pending, so you can retry;
  - paying a confirmed booking replays its payment instead of charging twice.
- **Live updates**: `SUBSCRIBE /trips/{id}` streams a platform change, an optional delay, the departure and the arrival (in UTC), as JSON Lines (default) or Server-Sent Events (`Accept: text/event-stream`), one event every 2 seconds.
- **XML**: send `Accept: application/xml` for XML responses, or `Content-Type: application/xml` to send an XML booking.

**Test cards**

| Number | Result |
| --- | --- |
| `4242424242424242` (or any other) | `status: succeeded` |
| `4000000000000002` | `status: failed` (declined) |
| `4000000000009995` | `status: failed` (insufficient funds) |

**Extras not in the spec.** None of them changes a response the spec describes.
- **Errors on demand**: `Prefer: code=429`, as Prism does, or `?__code=429` returns any status the spec documents for that operation, with the spec's example error body. `429` also sets `Retry-After`. Use `?__code=` when you cannot set headers, for example behind a CORS proxy.
- **Field errors**: a `400` also carries `errors[]`, an RFC 9457 extension member pointing at each invalid field (`/passenger_name`, `/source/number`, …).
- **Stream pace**: `?interval=<seconds>` on `SUBSCRIBE /trips/{id}` (default 2, maximum 10, `0` for instant).
- **Eviction notice**: when a space drops its oldest booking to stay under 200, `POST /bookings` adds an `X-Mock-Notice` header.
- `GET /` lists the endpoints.
- `GET /stations/{id}` and `GET /trips/{id}` exist so that the `links` in responses can be followed.

## Known limits

- **API Explorer on Bump.sh**: keep the Explorer's CORS proxy disabled. The proxy only forwards `GET, POST, PUT, PATCH, DELETE, OPTIONS`, so `QUERY /stations` and `SUBSCRIBE /trips/{id}` fail through it. The mock sends its own CORS headers for every method, so browsers can call it directly.
- **Public space**: without an `Authorization` header, everyone shares the same space, so `GET /bookings` lists other visitors' bookings. Enter any token in the Explorer to get a private one.
- **Webhooks**: the `newBooking` webhook is not sent, because the spec has no way to register a callback URL.
- **Rate limiting**: the `RateLimit` header is informational only; the mock never throttles. Cloudflare's free plan allows 100,000 requests a day.

## Develop

```sh
npm run dev         # http://localhost:8787
npm test            # unit, flow and contract tests in the Workers runtime
npm run typecheck
npm run lint
```

`test/contract.test.ts` validates every response against the schemas in `openapi.yaml` (OpenAPI 3.2, with formats asserted), fails on any response property that the spec neither declares nor shows in an example (except `errors[]` on problem details), checks that every example in the spec matches its own schema, and checks that `src/http/operations.ts` lists the same status codes as the spec. When the spec changes, these tests show what to update.

| Path | Role |
| --- | --- |
| `src/domain/` | Pure logic: stations and name resolution, timetables, station time zones, booking lifecycle, payments, validation, seeded random |
| `src/http/` | Content negotiation, Problem responses, pagination, `Prefer` handling |
| `src/routes/` | One Hono router per resource |
| `src/store/space.ts` | The Durable Object (SQLite) holding one data space |
