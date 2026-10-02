/**
 * The operations of the Train Travel API and the status codes the spec documents for each.
 * `test/contract.test.ts` asserts this table matches `openapi.yaml`, so it cannot drift.
 */
export interface Operation {
  method: string;
  path: string;
  statuses: number[];
}

const READ = [200, 400, 401, 403, 429, 500];

export const OPERATIONS = {
  "get-stations": { method: "GET", path: "/stations", statuses: READ },
  "query-stations": { method: "QUERY", path: "/stations", statuses: READ },
  "get-trips": { method: "GET", path: "/trips", statuses: READ },
  "subscribe-trip": { method: "SUBSCRIBE", path: "/trips/{id}", statuses: [200, 400, 401, 403, 404, 429, 500] },
  "get-bookings": { method: "GET", path: "/bookings", statuses: READ },
  "create-booking": { method: "POST", path: "/bookings", statuses: [201, 400, 401, 404, 409, 429, 500] },
  "get-booking": { method: "GET", path: "/bookings/{bookingId}", statuses: [200, 400, 401, 403, 404, 429, 500] },
  "delete-booking": { method: "DELETE", path: "/bookings/{bookingId}", statuses: [204, 400, 401, 403, 404, 429, 500] },
  "create-booking-payment": {
    method: "POST",
    path: "/bookings/{bookingId}/payment",
    statuses: [200, 400, 401, 403, 404, 409, 429, 500],
  },
} as const satisfies Record<string, Operation>;

export type OperationId = keyof typeof OPERATIONS;
