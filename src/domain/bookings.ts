import type { Currency } from "./payments";
import { seededRandom } from "./random";

/** How long an unpaid booking holds its trip. Real operators hold for 15–20 minutes; an hour leaves time to explore. */
export const HOLD_MINUTES = 60;

/** What the client sent, as stored. */
export interface Booking {
  id: string;
  trip_id: string;
  passenger_name: string;
  has_bicycle: boolean;
  has_dog: boolean;
}

export interface Ticket {
  reference: string;
  coach: string;
  seat: string;
  issued_at: string;
}

/** A stored booking with what it needs to run its lifecycle. */
export interface BookingRecord {
  booking: Booking;
  price: number;
  currency: Currency;
  created_at: string;
  expires_at: string;
  /** The trip's departure, to refuse paying for a train that has left. */
  departure_time: string;
  /** Issued once a payment succeeds. */
  ticket?: Ticket;
}

export type BookingStatus = "pending_payment" | "confirmed" | "expired";

/** Crockford base32: no I, L, O or U, so a reference reads unambiguously over the phone. */
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SEAT_LETTERS = ["A", "B", "C", "D"] as const;

function iso(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function holdUntil(createdAt: Date): string {
  return iso(new Date(createdAt.getTime() + HOLD_MINUTES * 60_000));
}

/** Derived on read, so a hold expires without any background job. */
export function bookingStatus(record: BookingRecord, now: Date): BookingStatus {
  if (record.ticket) return "confirmed";
  return now.getTime() > Date.parse(record.expires_at) ? "expired" : "pending_payment";
}

export function hasDeparted(departureTime: string, now: Date): boolean {
  return Date.parse(departureTime) <= now.getTime();
}

/** Seeded by the booking id: the same booking always gets the same reference and seat. */
export function issueTicket(bookingId: string, issuedAt: Date): Ticket {
  const random = seededRandom(`ticket|${bookingId}`);
  const reference = Array.from({ length: 6 }, () => random.pick([...REFERENCE_ALPHABET])).join("");
  return {
    reference: `TT-${reference}`,
    coach: String(random.int(1, 14)),
    seat: `${random.int(1, 80)}${random.pick(SEAT_LETTERS)}`,
    issued_at: iso(issuedAt),
  };
}

/** The booking as the API shows it: what was sent, plus its fare, hold and ticket. */
export function presentBooking(record: BookingRecord, now: Date) {
  return {
    ...record.booking,
    status: bookingStatus(record, now),
    price: record.price,
    currency: record.currency,
    expires_at: record.expires_at,
    ...(record.ticket ? { ticket: record.ticket } : {}),
  };
}
