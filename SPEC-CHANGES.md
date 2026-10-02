# Changes from the official Train Travel API

This file explains every difference between `openapi.yaml` in this repository and the official Train Travel API 1.3.0, as published at <https://bump.sh/bump-examples/doc/train-travel-api> (source: `https://bump.sh/bump-examples/doc/train-travel-api.yaml`).

The published spec is the GitHub source (`bump-sh-examples/train-travel-api`, `main`) plus `x-codeSamples` on eight operations. This file compares against the published version.

The changes aim at one thing: a traveller trying the API in the API Explorer can search, book, pay and get a ticket without copying ids around or hitting errors caused by the examples. All contract changes are **additive or relaxing**, so a client of the official spec keeps working.

## Summary

| Area | Change | Compatibility |
| --- | --- | --- |
| `servers` | Microcks mock replaced by the stateful mock | n/a |
| `info.description` | "Run in Postman" section removed | n/a |
| OAuth2 description | Note that the mock needs no real token | n/a |
| `GET /trips` | `origin`/`destination` accept a station name; `date` optional; local times | Relaxing |
| `Booking` | `status`, `price`, `currency`, `expires_at`, `ticket` (readOnly) | Additive |
| New schemas | `Ticket`, `Links-Booking-Actions` | Additive |
| `POST /bookings`, `GET /bookings/{id}` | `links` gains `trip` and `payment` | Additive |
| `POST /bookings/{id}/payment` | `404` and `409` documented; `amount` defaults to the booking price | Additive |
| Examples | Regenerated from the mock as one coherent journey; several defects fixed | n/a |
| `x-codeSamples` | Generated TypeScript SDK samples not carried over | Docs only |

## Servers

```diff
 servers:
-  - url: https://try.microcks.io/rest/Train+Travel+API/1.0.0
-    name: Mock Server
-    description: A mock server for testing and development purposes
+  - url: https://train-travel-mock.train-travel-mock.workers.dev
+    name: Mock Server
+    description: |
+      A stateful mock server for testing and development purposes. Book a trip end to end:
+      ids returned by one call work in the next. Any `Authorization` header value gives you
+      a private data space (none shares a public one); data expires after 24 hours idle.
+      Force any documented error with `Prefer: code=404` or `?__code=404`.
   - url: https://api.example.com
     name: Production
```

**Why:** the Microcks mock returned static examples, so ids never chained from one call to the next, and it timed out during testing. The new mock keeps state per token and follows this spec (see `README.md`).

## `info.description`

The "Run in Postman" heading, sentence and button are removed. The API Explorer now covers the same need, against a mock that works end to end.

## Authentication

The `OAuth2` scheme description gains one paragraph:

> On the mock server, no token is required: any value you enter gives you a private sandbox, and without one you share a public sandbox.

**Why:** the OAuth URLs point to `example.com`, so nobody can get a real token, and the Explorer shows a token field that a user would otherwise not know how to fill.

## `GET /trips`

```diff
       - name: origin
-        description: The ID of the origin station
+        description: >
+          The origin station: its ID, or a station name to search for (for example
+          `Berlin` or `Berlin Hbf`). A name resolves to the best-matching station.
         required: true
         schema:
           type: string
-          format: uuid
-        example: efdbb9d1-02c2-4bc3-afb7-6788d8782b1e
+        example: Berlin
       # destination: same change, example `Paris`
       - name: date
-        description: The date and time of the trip in ISO 8601 format in origin station's timezone.
-        required: true
+        description: >
+          The earliest departure, in ISO 8601 format. Without a UTC offset, it is
+          read in the origin station's timezone. A date alone means the start of
+          that day. Defaults to now.
+        required: false
         schema:
           type: string
           format: date-time
-        example: '2024-02-01T09:00:00Z'
+        example: '2027-06-15T09:00'
```

The operation description adds that times are expressed in the local time of each station.

**Why:**
- The Explorer does not prefill parameters: the example only shows as a placeholder. A user therefore had to copy two UUIDs from `GET /stations` before getting any trip, and the first attempt returned `400`. A name now works, and an ID still works.
- A "next departures" search should not require a date.
- The original description already said `date` is in the origin station's timezone. The Explorer's date picker sends a date-time without offset (`2026-11-02T09:00`), which is now read that way. Trip times carry the UTC offset of their station (`2027-06-15T09:11:00+02:00`), which is valid `date-time`.

## Booking lifecycle

`Booking` gains five read-only properties, plus a new `Ticket` schema:

```yaml
status:      enum [pending_payment, confirmed, expired]
price:       number      # the fare
currency:    enum [bam, bgn, chf, eur, gbp, nok, sek, try]
expires_at:  date-time   # end of the hold if unpaid
ticket:      $ref Ticket # present once confirmed

Ticket:      # required: reference, coach, seat, issued_at
  reference: string, pattern ^TT-[0-9A-HJKMNP-TV-Z]{6}$   # e.g. TT-7KQ2PX
  coach:     string
  seat:      string
  issued_at: date-time
```

The single-booking responses (`201` of `POST /bookings`, `200` of `GET /bookings/{bookingId}`, JSON and XML) now use `Links-Booking-Actions` instead of `Links-Self`. It keeps `self` and adds `trip` and `payment`.

The descriptions of `POST /bookings` and `POST /bookings/{bookingId}/payment` explain the lifecycle:
- a new booking is on hold (`pending_payment`) until `expires_at`;
- a successful payment confirms it and issues the ticket;
- a failed payment leaves it pending, so it can be retried;
- paying a confirmed booking returns the existing payment;
- booking a train that has departed, or bringing a bicycle or dog where they are not allowed, is a conflict.

**Why:** the original text already promised this ("*A booking is a temporary hold on a trip. It is not confirmed until the payment is processed*", "*…enable them to get their tickets*"), but nothing in the schema showed it. A traveller could pay and then not see any difference on the booking.

## Payment

```diff
       responses:
         '200': …
         '400': …
         '401': …
         '403': …
+        '404':
+          $ref: '#/components/responses/NotFound'
+        '409':
+          $ref: '#/components/responses/Conflict'
         '429': …
```

- `404` covers an unknown booking. `409` covers an expired hold or a train that has already departed.
- `amount` description: "*Defaults to the booking price.*"

### Card `cvc`: a mock behaviour, not a spec change

The spec still marks `cvc` as required. The mock accepts a card without it, and still validates it when it is sent. The Bump.sh API Explorer hides `writeOnly` fields from request forms, so without this every card payment made from the Explorer failed with `400 source.cvc is required`. The spec stays correct; the Explorer should show `writeOnly` fields in requests.

## Examples

All examples were produced by running the mock: Berlin → Paris on 15 June 2027, booking, card and bank payments, live updates. Links use `https://api.example.com`. Together they form one chain: the booking request uses the first trip of the trips example, the payment and booking examples use that booking, and `SUBSCRIBE` uses that trip. `npm test` validates every JSON response example against its schema. The streamed `serializedValue` examples of `SUBSCRIBE` are copied verbatim from the mock's output.

Defects fixed along the way:

| Where | Before | After |
| --- | --- | --- |
| Booking request, `Booking.id`, `Booking.trip_id`, `Trip.id` | `4f4e4e1-…` / `3f3e3e1-…`: 7 hex characters, invalid UUIDs | Valid UUIDs from the mock |
| Trips, live updates | Dates in 2024, so in the past | 2027-06-15, in station local time |
| Card payment request and response | `exp_year: 2025`, already expired | `2030` |
| Card payment response | Echoed `cvc: "123"`, a `writeOnly` field | `cvc` removed |
| Card payment response | `links.booking` pointed to `…/payment` | Points to the booking |
| Bank payment response | Masked number `*********2345` for an 8-digit account | `****2345` |
| Payment amounts and currency | `49.99 gbp` / `100.5 gbp`, unrelated to the trip | The trip fares, in `eur` (the origin is Berlin) |
| Query stations response | Unknown station id, `Piazza Ducca d'Aosta, 20214`, timezone `Europe/Milano` (not an IANA zone), "closed to" | Catalogue id, `Piazza Duca d'Aosta 1, 20124 Milano`, `Europe/Rome`, "close to" |
| Query stations HTTP sample | Searches Milano Centrale with `country: "DE"` | `country: "IT"` |
| Stations list links | `self: …/stations&page=2` (`&` instead of `?`) | Real pagination links |
| Path examples (`bookingId`, trip `id`) | `1725ff48-…`, `ea399ba1-…`, unknown everywhere | The example booking and trip |
| Booking examples | `trip_id` equal to a station id | The booked trip's id |
| `newBooking` webhook example | Same station-id mix-up | The created booking |
| Field examples `Trip.price`, `BookingPayment.amount` | `50`, `49.99` | `140.9`, the fare used throughout the examples (also used for the new `Booking.price`) |

## Not carried over: `x-codeSamples`

The published spec carries generated TypeScript SDK samples (`train-travel-sdk`) on `GET /stations`, `QUERY /stations`, `GET /trips`, `GET` and `POST /bookings`, `GET` and `DELETE /bookings/{bookingId}`, and the payment operation. They are not in this file. They were never in the GitHub source either: they are added when the docs are published.

They also embed the old example values (`tripId: "4f4e4e1-…"`, `date: new Date("2024-02-01T09:00:00Z")`). If they are regenerated from this spec, they will pick up the new examples. The `http` sample of `QUERY /stations`, which is in the source, is kept and fixed.

## Reproduce this comparison

```sh
curl -sL https://bump.sh/bump-examples/doc/train-travel-api.yaml -o official.yaml
git diff --no-index official.yaml openapi.yaml
```
