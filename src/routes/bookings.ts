import { type Context, Hono } from "hono";
import { currencyForCountry, settle, validatePayment } from "../domain/payments";
import { findStation } from "../domain/stations";
import { summarize, validateFields } from "../domain/validation";
import type { AppEnv } from "../http/app-env";
import { baseUrl } from "../http/links";
import { collection, readPage } from "../http/pagination";
import { operation } from "../http/prefer";
import { problem } from "../http/problem";
import { readBody, send, sendProblem } from "../http/respond";
import { spaceFor } from "../http/space";
import { type Booking, MAX_BOOKINGS } from "../store/space";

export const bookings = new Hono<AppEnv>({ strict: false });

const NO_STORE = { "Cache-Control": "no-store" };

function bookingUrl(c: Context<AppEnv>, id: string): string {
  return `${baseUrl(c)}/bookings/${id}`;
}

function withLinks(c: Context<AppEnv>, booking: Booking) {
  return { ...booking, links: { self: bookingUrl(c, booking.id) } };
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
  const body = collection(
    c,
    items.map((booking) => withLinks(c, booking)),
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

  const { evicted } = await space.createBooking({
    booking,
    price: trip.price,
    currency: currencyForCountry(findStation(trip.origin)?.country_code),
  });
  const location = bookingUrl(c, booking.id);
  return send(c, 201, withLinks(c, booking), {
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
  return send(c, 200, withLinks(c, record.booking), { xml: { root: "booking" }, headers: NO_STORE });
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
  // 404 is not documented for this operation in the spec, but it is the honest answer.
  if (!record) return bookingNotFound(c, id);

  const body = await readBody(c);
  if (!body.ok) return body.response;
  const { input, errors } = validatePayment(body.value);
  if (!input) return sendProblem(c, problem(400, summarize(errors), errors));

  const respond = (payment: object) =>
    send(c, 200, { ...payment, links: { booking: bookingUrl(c, id) } }, { headers: NO_STORE });

  // Idempotent: a booking that is already paid returns its payment instead of charging twice.
  const existing = await space.getPayment(id);
  if (existing?.status === "succeeded") return respond(existing);

  const payment = settle(crypto.randomUUID(), input, { amount: record.price, currency: record.currency });
  await space.savePayment(id, payment);
  return respond(payment);
});
