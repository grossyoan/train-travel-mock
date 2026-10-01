/**
 * Contract test: the spec is the source of truth. Every response the mock produces for
 * a documented operation must validate against the schema the spec declares for that
 * operation, status code and media type.
 */
import "@hyperjump/json-schema/formats";
import {
  type OutputFormat,
  registerSchema,
  type SchemaObject,
  setShouldValidateFormat,
  validate,
} from "@hyperjump/json-schema/openapi-3-2";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import specText from "../openapi.yaml?raw";
import { OPERATIONS } from "../src/http/operations";
import { BANK, BERLIN, type Booking, CARD, type Collection, call, freshToken, json, PARIS, type Trip } from "./helpers";

interface MediaType {
  schema?: unknown;
  itemSchema?: unknown;
}
interface ResponseObject {
  $ref?: string;
  content?: Record<string, MediaType>;
}
interface OperationObject {
  operationId: string;
  responses: Record<string, ResponseObject>;
}
interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, ResponseObject> };
}

const spec = parse(specText) as Spec;
const BASE_URI = "https://contract.test";
const DIALECT = "https://spec.openapis.org/oas/3.2/dialect";
/** Report every failing keyword, not just a boolean. */
const OUTPUT: OutputFormat = "BASIC";
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"];

/** Rewrites spec-internal refs so that standalone schemas resolve against the registered components. */
function rewriteRefs<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll('"#/components/schemas/', `"${BASE_URI}/components#/$defs/`)) as T;
}

/**
 * OpenAPI semantics: a writeOnly property listed in `required` is only required in requests.
 * Plain JSON Schema validation does not know the direction, so response schemas drop it.
 */
function forResponses(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(forResponses);
  if (value === null || typeof value !== "object") return value;
  const schema = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, forResponses(child)]));
  const properties = schema.properties as Record<string, { writeOnly?: boolean }> | undefined;
  if (Array.isArray(schema.required) && properties) {
    schema.required = schema.required.filter((name: string) => properties[name]?.writeOnly !== true);
  }
  return schema;
}

function specOperations(): Map<string, { method: string; path: string; operation: OperationObject }> {
  const operations = new Map<string, { method: string; path: string; operation: OperationObject }>();
  for (const [path, item] of Object.entries(spec.paths)) {
    const entries: [string, unknown][] = Object.entries(item).filter(([key]) => HTTP_METHODS.includes(key));
    const additional = item.additionalOperations as Record<string, unknown> | undefined;
    entries.push(...Object.entries(additional ?? {}));
    for (const [method, operation] of entries) {
      const op = operation as OperationObject;
      operations.set(op.operationId, { method: method.toUpperCase(), path, operation: op });
    }
  }
  return operations;
}

const operations = specOperations();

function responseObject(operationId: string, status: number): ResponseObject {
  const operation = operations.get(operationId)?.operation;
  if (!operation) throw new Error(`Unknown operation ${operationId}`);
  const response = operation.responses[String(status)];
  if (!response) throw new Error(`${operationId} does not document status ${status}`);
  if (response.$ref) {
    const name = response.$ref.replace("#/components/responses/", "");
    const resolved = spec.components.responses[name];
    if (!resolved) throw new Error(`Unresolved ${response.$ref}`);
    return resolved;
  }
  return response;
}

const registered = new Set<string>();

async function expectConformant(operationId: string, response: Response) {
  const contentType = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim() ?? "";
  const media = responseObject(operationId, response.status).content?.[contentType];
  expect(media, `${operationId} ${response.status} does not document ${contentType}`).toBeDefined();
  const uri = `${BASE_URI}/${operationId}/${response.status}/${encodeURIComponent(contentType)}`;
  if (!registered.has(uri)) {
    registerSchema(rewriteRefs((media?.schema ?? media?.itemSchema) as SchemaObject), uri, DIALECT);
    registered.add(uri);
  }
  const text = await response.text();
  const instances =
    contentType === "application/jsonl"
      ? text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : contentType === "text/event-stream"
        ? text
            .trim()
            .split("\n\n")
            .map((block) => {
              const [event, data] = block.split("\n");
              return { event: event?.replace("event: ", ""), data: data?.replace("data: ", "") };
            })
        : [JSON.parse(text)];
  for (const instance of instances) {
    const output = await validate(uri, instance, OUTPUT);
    expect(output, `${operationId} ${response.status} ${JSON.stringify(instance)}`).toMatchObject({ valid: true });
    // `contentSchema` is only an annotation: check the JSON inside each SSE `data` explicitly.
    if (contentType === "text/event-stream") {
      const update = JSON.parse(String(instance.data));
      const updateOutput = await validate(`${BASE_URI}/components#/$defs/TripUpdate`, update, OUTPUT);
      expect(updateOutput, `SSE data ${instance.data}`).toMatchObject({ valid: true });
      expect(update.type).toBe(instance.event);
    }
  }
}

const covered = new Map<string, Set<number>>();
async function check(operationId: string, response: Response, expectedStatus: number) {
  expect(response.status, operationId).toBe(expectedStatus);
  if (!covered.has(operationId)) covered.set(operationId, new Set());
  covered.get(operationId)?.add(expectedStatus);
  if (expectedStatus === 204) return;
  await expectConformant(operationId, response);
}

describe("contract", () => {
  beforeAll(() => {
    // Formats (uuid, date-time, uri) are annotations by default in 2020-12: assert them.
    setShouldValidateFormat(true);
    registerSchema(
      { $defs: forResponses(rewriteRefs(spec.components.schemas)) } as SchemaObject,
      `${BASE_URI}/components`,
      DIALECT,
    );
  });

  it("documents the same status codes in code as in the spec", () => {
    const fromSpec = Object.fromEntries(
      [...operations].map(([id, { method, path, operation }]) => [
        id,
        { method, path, statuses: Object.keys(operation.responses).map(Number) },
      ]),
    );
    const fromCode = Object.fromEntries(
      Object.entries(OPERATIONS).map(([id, op]) => [id, { method: op.method, path: op.path, statuses: op.statuses }]),
    );
    expect(fromCode).toEqual(fromSpec);
  });

  it("produces conformant responses for every operation", async () => {
    const token = freshToken();

    await check("get-stations", await call("GET", "/stations?country=DE", { token }), 200);
    await check("query-stations", await call("QUERY", "/stations", { token, body: { search: "Paris" } }), 200);

    const tripsResponse = await call("GET", `/trips?origin=${BERLIN}&destination=${PARIS}&date=2026-11-02T08:00:00Z`, {
      token,
    });
    const trips = await json<Collection<Trip>>(tripsResponse.clone());
    await check("get-trips", tripsResponse, 200);
    const trip = trips.data[0] as Trip;

    const created = await call("POST", "/bookings", { token, body: { trip_id: trip.id, passenger_name: "Contract" } });
    const booking = await json<Booking>(created.clone());
    await check("create-booking", created, 201);
    await check("get-booking", await call("GET", `/bookings/${booking.id}`, { token }), 200);
    await check("get-bookings", await call("GET", "/bookings", { token }), 200);
    await check(
      "create-booking-payment",
      await call("POST", `/bookings/${booking.id}/payment`, {
        token,
        body: { amount: 10, currency: "eur", source: CARD },
      }),
      200,
    );

    const second = await json<Booking>(
      await call("POST", "/bookings", { token, body: { trip_id: trip.id, passenger_name: "Bank" } }),
    );
    await check(
      "create-booking-payment",
      await call("POST", `/bookings/${second.id}/payment`, {
        token,
        body: { amount: 10, currency: "gbp", source: BANK },
      }),
      200,
    );

    await check(
      "subscribe-trip",
      await call("SUBSCRIBE", `/trips/${trip.id}?interval=0`, { token, headers: { Accept: "application/jsonl" } }),
      200,
    );
    await check(
      "subscribe-trip",
      await call("SUBSCRIBE", `/trips/${trip.id}?interval=0`, { token, headers: { Accept: "text/event-stream" } }),
      200,
    );
    await check("delete-booking", await call("DELETE", `/bookings/${booking.id}`, { token }), 204);
  });

  it("produces conformant error responses", async () => {
    const token = freshToken();
    await check("create-booking", await call("POST", "/bookings", { token, body: {} }), 400);
    await check(
      "create-booking",
      await call("POST", "/bookings", { token, body: { trip_id: crypto.randomUUID(), passenger_name: "Nobody" } }),
      404,
    );
    await check("get-booking", await call("GET", `/bookings/${crypto.randomUUID()}`, { token }), 404);
    await check("delete-booking", await call("DELETE", `/bookings/${crypto.randomUUID()}`, { token }), 404);
    await check("get-trips", await call("GET", "/trips", { token }), 400);
    await check("subscribe-trip", await call("SUBSCRIBE", `/trips/${crypto.randomUUID()}`, { token }), 404);

    for (const [operationId, operation] of Object.entries(OPERATIONS)) {
      for (const status of operation.statuses.filter((code) => code >= 400)) {
        const path = operation.path.replace("{bookingId}", crypto.randomUUID()).replace("{id}", crypto.randomUUID());
        await check(operationId, await call(operation.method, `${path}?__code=${status}`, { token }), status);
      }
    }
  });

  it("covered every documented operation", () => {
    for (const operationId of operations.keys()) {
      expect(
        [...(covered.get(operationId) ?? [])].some((status) => status < 300),
        operationId,
      ).toBe(true);
    }
  });
});
