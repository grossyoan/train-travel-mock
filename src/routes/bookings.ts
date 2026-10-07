import { type Context, Hono } from "hono";
import {
  type Booking,
  type BookingRecord,
  bookingStatus,
  hasDeparted,
  holdUntil,
  presentBooking,
} from "../domain/bookings";
import { settle, validatePayment } from "../domain/payments";
import { formatUtc } from "../domain/time";
import { tripCurrency } from "../domain/trips";
import { summarize, validateFields } from "../domain/validation";
import type { AppEnv } from "../http/app-env";
import { baseUrl } from "../http/links";
import { collection, readPage } from "../http/pagination";
import { operation } from "../http/prefer";
import { problem } from "../http/problem";
import { readBody, send, sendProblem } from "../http/respond";
import { spaceFor } from "../http/space";
import { MAX_BOOKINGS } from "../store/space";

export const bookings = new Hono<AppEnv>({ strict: false });

const NO_STORE = { "Cache-Control": "no-store" };

function bookingUrl(c: Context<AppEnv>, id: string): string {
  return `${baseUrl(c)}/bookings/${id}`;
}

/** A single booking carries `Links-Self`; in a list, the spec shows plain bookings. */
function present(c: Context<AppEnv>, record: BookingRecord, now = new Date()) {
  return { ...presentBooking(record, now), links: { self: bookingUrl(c, record.booking.id) } };
}

function departed(c: Context<AppEnv>, departureTime: string) {
  return sendProblem(
    c,
    problem(409, `This train departed at ${departureTime}. Search trips with GET /trips for a later departure.`),
  );
}

function bookingNotFound(c: Context<AppEnv>, id: string) {
  return sendProblem(
    c,
    problem(
      404,
      `Booking ${id} was not found. Bookings are only visible with the Authorization header used to create them.`,
    ),
  );
}

bookings.get("/bookings", operation("get-bookings"), async (c) => {
  const page = readPage(c);
  const { bookings: items, total } = await (await spaceFor(c)).listBookings(page.offset, page.limit);
  const now = new Date();
  const body = collection(
    c,
    items.map((record) => presentBooking(record, now)),
    page,
    total,
  );
  return send(c, 200, body, { xml: { collection: "bookings", item: "booking" }, headers: NO_STORE });
});

bookings.post("/bookings", operation("create-booking"), async (c) => {
  const body = await readBody(c);
  if (!body.ok) return body.response;
  const { values, errors } = validateFields(body.value, {
    trip_id: { type: "string", required: true },
    passenger_name: { type: "string", required: true },
    has_bicycle: { type: "boolean" },
    has_dog: { type: "boolean" },
  });
  if (errors.length > 0) return sendProblem(c, problem(400, summarize(errors), errors));

  const space = await spaceFor(c);
  const tripId = String(values.trip_id);
  const trip = await space.getTrip(tripId);
  if (!trip) {
    return sendProblem(
      c,
      problem(
        404,
        `Trip ${tripId} was not found. Search trips with GET /trips first: trips are remembered per Authorization header.`,
      ),
    );
  }
  const now = new Date();
  if (hasDeparted(trip.departure_time, now)) return departed(c, trip.departure_time);
  const booking: Booking = {
    id: crypto.randomUUID(),
    trip_id: trip.id,
    passenger_name: String(values.passenger_name).trim(),
    has_bicycle: values.has_bicycle === true,
    has_dog: values.has_dog === true,
  };
  if (booking.has_bicycle && !trip.bicycles_allowed) {
    return sendProblem(
      c,
      problem(409, `Trip ${trip.id} does not allow bicycles. Search with bicycles=true to find one that does.`),
    );
  }
  if (booking.has_dog && !trip.dogs_allowed) {
    return sendProblem(
      c,
      problem(409, `Trip ${trip.id} does not allow dogs. Search with dogs=true to find one that does.`),
    );
  }

  const record: BookingRecord = {
    booking,
    origin: trip.origin,
    destination: trip.destination,
    price: trip.price,
    currency: tripCurrency(trip),
    expires_at: holdUntil(now),
    departure_time: trip.departure_time,
  };
  const { evicted } = await space.createBooking(record);
  const location = bookingUrl(c, booking.id);
  return send(c, 201, present(c, record, now), {
    xml: { root: "booking" },
    headers: {
      ...NO_STORE,
      Location: location,
      ...(evicted
        ? { "X-Mock-Notice": `This space keeps the ${MAX_BOOKINGS} most recent bookings; the oldest was removed.` }
        : {}),
    },
  });
});

bookings.get("/bookings/:bookingId", operation("get-booking"), async (c) => {
  const id = c.req.param("bookingId");
  const record = await (await spaceFor(c)).getBooking(id);
  if (!record) return bookingNotFound(c, id);
  return send(c, 200, present(c, record), { xml: { root: "booking" }, headers: NO_STORE });
});

bookings.delete("/bookings/:bookingId", operation("delete-booking"), async (c) => {
  const id = c.req.param("bookingId");
  const deleted = await (await spaceFor(c)).deleteBooking(id);
  if (!deleted) return bookingNotFound(c, id);
  return new Response(null, { status: 204 });
});

bookings.post("/bookings/:bookingId/payment", operation("create-booking-payment"), async (c) => {
  const id = c.req.param("bookingId");
  const space = await spaceFor(c);
  const record = await space.getBooking(id);
  if (!record) return bookingNotFound(c, id);

  const body = await readBody(c);
  if (!body.ok) return body.response;
  const { input, errors } = validatePayment(body.value);
  if (!input) return sendProblem(c, problem(400, summarize(errors), errors));

  const respond = (payment: object) =>
    send(c, 200, { ...payment, links: { booking: bookingUrl(c, id) } }, { headers: NO_STORE });

  const now = new Date();
  const status = bookingStatus(record, now);
  // Idempotent: a confirmed booking returns its payment instead of charging twice.
  if (status === "confirmed") {
    const existing = await space.getPayment(id);
    if (existing) return respond(existing);
  }
  if (status === "expired") {
    return sendProblem(
      c,
      problem(
        409,
        `The hold on booking ${id} expired at ${record.expires_at}. Create a new booking to pay for this trip.`,
      ),
    );
  }
  if (hasDeparted(record.departure_time, now)) return departed(c, record.departure_time);

  const payment = settle(crypto.randomUUID(), input, { amount: record.price, currency: record.currency });
  await space.savePayment(record, payment, payment.status === "succeeded" ? formatUtc(now) : undefined);
  return respond(payment);
});
