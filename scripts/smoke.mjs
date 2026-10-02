#!/usr/bin/env node
/**
 * End-to-end smoke test over real HTTP, against a local or deployed mock.
 *
 *   npm run smoke -- http://localhost:8787
 *   npm run smoke -- https://train-travel-mock.<subdomain>.workers.dev
 *
 * Checks values, not just status codes, and exits non-zero on the first failure.
 */
import assert from "node:assert/strict";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const token = `smoke-${crypto.randomUUID()}`;
const BERLIN = "efdbb9d1-02c2-4bc3-afb7-6788d8782b1e";
const PARIS = "b2e783e1-c824-4d63-b37a-d8d698862f1d";
const CARD = {
  object: "card",
  name: "Francis Bourgeois",
  number: "4242424242424242",
  cvc: "123",
  exp_month: 12,
  exp_year: 2030,
  address_country: "gb",
};
const date = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

async function call(method, path, { body, headers = {}, auth = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response;
}

let passed = 0;
async function step(name, run) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exit(1);
  }
}

console.log(`Smoke test against ${base}\n`);
let trip;
let booking;

await step("GET /stations finds Berlin Hauptbahnhof", async () => {
  const response = await call("GET", "/stations?search=berlin");
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data[0].id, BERLIN);
});

await step("QUERY /stations filters from the body", async () => {
  const response = await call("QUERY", "/stations", { body: { search: "Milano", country: "IT" } });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(
    data.map((station) => station.name),
    ["Milano Centrale"],
  );
});

await step("GET /trips?origin=Berlin&destination=Paris (names, no date) → next departures in local time", async () => {
  const response = await call("GET", "/trips?origin=Berlin&destination=Paris");
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.ok(data.length >= 3, `expected ≥ 3 trips, got ${data.length}`);
  assert.ok(data.every((item) => item.origin === BERLIN && item.destination === PARIS));
  assert.match(data[0].departure_time, /[+-]\d{2}:\d{2}$/);
});

await step(`GET /trips by id on ${date}`, async () => {
  const response = await call("GET", `/trips?origin=${BERLIN}&destination=${PARIS}&date=${date}T09:00`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  trip = data.find((item) => item.bicycles_allowed) ?? data[0];
});

await step("POST /bookings → 201 pending_payment, with price, hold and links", async () => {
  const response = await call("POST", "/bookings", { body: { trip_id: trip.id, passenger_name: "Smoke Test" } });
  assert.equal(response.status, 201);
  booking = await response.json();
  assert.equal(response.headers.get("Location"), booking.links.self);
  assert.equal(booking.trip_id, trip.id);
  assert.equal(booking.status, "pending_payment");
  assert.equal(booking.price, trip.price);
  assert.ok(Date.parse(booking.expires_at) > Date.now());
  assert.equal(booking.links.payment, `${booking.links.self}/payment`);
});

await step(
  "POST /bookings/{id}/payment with a card and no cvc (as the API Explorer sends it) → succeeded",
  async () => {
    const { cvc: _omitted, ...card } = CARD;
    const response = await call("POST", `/bookings/${booking.id}/payment`, { body: { source: card } });
    assert.equal(response.status, 200);
    const payment = await response.json();
    assert.equal(payment.status, "succeeded");
    assert.equal(payment.amount, trip.price);
    assert.equal(payment.source.number, "************4242");
    assert.equal(payment.source.cvc, undefined);
  },
);

await step("GET /bookings/{id} → confirmed, with a ticket", async () => {
  const response = await call("GET", `/bookings/${booking.id}`);
  const confirmed = await response.json();
  assert.equal(confirmed.status, "confirmed");
  assert.match(confirmed.ticket.reference, /^TT-[0-9A-HJKMNP-TV-Z]{6}$/);
});

await step("another token cannot see the booking", async () => {
  const response = await call("GET", `/bookings/${booking.id}`, { headers: { Authorization: "Bearer someone-else" } });
  assert.equal(response.status, 404);
});

await step("missing required fields → 400 naming them", async () => {
  const response = await call("POST", "/bookings", { body: {} });
  assert.equal(response.status, 400);
  const problem = await response.json();
  assert.match(problem.detail, /trip_id.*passenger_name/);
});

await step("?__code=429 → 429 with Retry-After", async () => {
  const response = await call("GET", "/bookings?__code=429");
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("Retry-After"));
});

await step("Accept: application/xml → XML", async () => {
  const response = await call("GET", "/stations?limit=1", { headers: { Accept: "application/xml" } });
  assert.match(response.headers.get("Content-Type"), /application\/xml/);
  assert.match(await response.text(), /<station>/);
});

await step("SUBSCRIBE /trips/{id} streams SSE until arrival", async () => {
  const response = await call("SUBSCRIBE", `/trips/${trip.id}?interval=0.2`, {
    headers: { Accept: "text/event-stream" },
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n\n");
  assert.ok(events.length >= 3);
  assert.match(events.at(-1), /^event: arrived/);
});

await step("CORS preflight allows DELETE with Authorization", async () => {
  const response = await fetch(`${base}/bookings/${booking.id}`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://bump.sh",
      "Access-Control-Request-Method": "DELETE",
      "Access-Control-Request-Headers": "authorization",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

await step("DELETE /bookings/{id} → 204, then 404", async () => {
  assert.equal((await call("DELETE", `/bookings/${booking.id}`)).status, 204);
  assert.equal((await call("GET", `/bookings/${booking.id}`)).status, 404);
});

console.log(`\n${passed} checks passed.`);
