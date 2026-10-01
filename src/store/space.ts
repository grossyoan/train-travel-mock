import { DurableObject } from "cloudflare:workers";
import type { Currency, Payment } from "../domain/payments";
import type { Trip } from "../domain/trips";

export interface Booking {
  id: string;
  trip_id: string;
  passenger_name: string;
  has_bicycle: boolean;
  has_dog: boolean;
}

/** What a booking remembers about its trip, so a payment can default to the fare. */
export interface BookingRecord {
  booking: Booking;
  price: number;
  currency: Currency;
}

export const MAX_BOOKINGS = 200;
const MAX_TRIPS = 2_000;
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
/** Re-arm the expiry alarm at most once an hour, to keep storage writes low. */
const ALARM_SLACK_MS = 60 * 60 * 1000;

/**
 * One data space: everything a given Authorization token (or the anonymous public
 * space) has searched, booked and paid. A space deletes itself after 24 hours idle.
 */
export class Space extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.createSchema());
  }

  private createSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bookings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payments (booking_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
  }

  private async touch(): Promise<void> {
    const expiry = Date.now() + IDLE_TTL_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < expiry - ALARM_SLACK_MS) await this.ctx.storage.setAlarm(expiry);
  }

  /** Expiry: wipe the space. The instance may stay in memory, so the empty schema is recreated. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.createSchema();
  }

  async saveTrips(trips: readonly Trip[]): Promise<void> {
    await this.touch();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      for (const trip of trips) {
        sql.exec("INSERT OR IGNORE INTO trips (id, data) VALUES (?, ?)", trip.id, JSON.stringify(trip));
      }
      sql.exec(
        "DELETE FROM trips WHERE rowid IN (SELECT rowid FROM trips ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
        MAX_TRIPS,
      );
    });
  }

  async getTrip(id: string): Promise<Trip | undefined> {
    await this.touch();
    const row = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM trips WHERE id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.data) as Trip) : undefined;
  }

  /** Stores a booking. Returns true when the oldest booking had to be evicted to stay under the cap. */
  async createBooking(record: BookingRecord): Promise<{ evicted: boolean }> {
    await this.touch();
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO bookings (id, data) VALUES (?, ?)", record.booking.id, JSON.stringify(record));
      const evicted = sql
        .exec<{ id: string }>(
          "DELETE FROM bookings WHERE seq IN (SELECT seq FROM bookings ORDER BY seq DESC LIMIT -1 OFFSET ?) RETURNING id",
          MAX_BOOKINGS,
        )
        .toArray();
      for (const { id } of evicted) sql.exec("DELETE FROM payments WHERE booking_id = ?", id);
      return { evicted: evicted.length > 0 };
    });
  }

  async getBooking(id: string): Promise<BookingRecord | undefined> {
    await this.touch();
    const row = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM bookings WHERE id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.data) as BookingRecord) : undefined;
  }

  /** Newest first. */
  async listBookings(offset: number, limit: number): Promise<{ bookings: Booking[]; total: number }> {
    await this.touch();
    const sql = this.ctx.storage.sql;
    const total = sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM bookings").one().total;
    const rows = sql
      .exec<{ data: string }>("SELECT data FROM bookings ORDER BY seq DESC LIMIT ? OFFSET ?", limit, offset)
      .toArray();
    return { bookings: rows.map((row) => (JSON.parse(row.data) as BookingRecord).booking), total };
  }

  async deleteBooking(id: string): Promise<boolean> {
    await this.touch();
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM payments WHERE booking_id = ?", id);
      return sql.exec("DELETE FROM bookings WHERE id = ?", id).rowsWritten > 0;
    });
  }

  async getPayment(bookingId: string): Promise<Payment | undefined> {
    await this.touch();
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM payments WHERE booking_id = ?", bookingId)
      .toArray()[0];
    return row ? (JSON.parse(row.data) as Payment) : undefined;
  }

  async savePayment(bookingId: string, payment: Payment): Promise<void> {
    await this.touch();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO payments (booking_id, data) VALUES (?, ?)",
      bookingId,
      JSON.stringify(payment),
    );
  }
}
