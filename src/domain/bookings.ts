import type { Currency } from "./payments";
import { stationName } from "./stations";
import { formatUtc } from "./time";

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

/** A stored booking with what it needs to run its lifecycle. */
export interface BookingRecord {
  booking: Booking;
  /** Station ids of the booked trip: trips can be evicted from a space, bookings outlive them. */
  origin: string;
  destination: string;
  price: number;
  currency: Currency;
  expires_at: string;
  /** The trip's departure, to refuse paying for a train that has left. */
  departure_time: string;
  /** Set once a payment succeeds: the booking is then confirmed. */
  paid_at?: string;
}

export type BookingStatus = "pending_payment" | "confirmed" | "expired";

export function holdUntil(createdAt: Date): string {
  return formatUtc(new Date(createdAt.getTime() + HOLD_MINUTES * 60_000));
}

/** Derived on read, so a hold expires without any background job. */
export function bookingStatus(record: BookingRecord, now: Date): BookingStatus {
  if (record.paid_at) return "confirmed";
  return now.getTime() > Date.parse(record.expires_at) ? "expired" : "pending_payment";
}

export function hasDeparted(departureTime: string, now: Date): boolean {
  return Date.parse(departureTime) <= now.getTime();
}

/** The booking as the API shows it: what was sent, plus its stations, status, fare and hold. Keys follow the spec's order. */
export function presentBooking(record: BookingRecord, now: Date) {
  const { id, trip_id, ...rest } = record.booking;
  return {
    id,
    trip_id,
    origin_name: stationName(record.origin),
    destination_name: stationName(record.destination),
    ...rest,
    status: bookingStatus(record, now),
    price: record.price,
    currency: record.currency,
    expires_at: record.expires_at,
  };
}
