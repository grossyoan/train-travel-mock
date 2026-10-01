import { Hono } from "hono";
import { cors } from "hono/cors";
import { DECLINED_CARDS } from "./domain/payments";
import type { AppEnv } from "./http/app-env";
import { OPERATIONS } from "./http/operations";
import { problem } from "./http/problem";
import { send, sendProblem } from "./http/respond";
import { bookings } from "./routes/bookings";
import { stations } from "./routes/stations";
import { trips } from "./routes/trips";

export { Space } from "./store/space";

const DOCUMENTATION = "https://bump.sh/bump-examples/doc/train-travel-api";
/** Advertised in the RateLimit header. Informational only: the mock never throttles. */
const RATE_LIMIT = 1000;

/** Every path the mock serves, with its methods, for 405 responses and the Allow header. */
const ALLOWED_METHODS: Readonly<Record<string, string>> = {
  "/stations": "GET, QUERY",
  "/stations/:id": "GET",
  "/trips": "GET",
  "/trips/:id": "GET, SUBSCRIBE",
  "/bookings": "GET, POST",
  "/bookings/:bookingId": "GET, DELETE",
  "/bookings/:bookingId/payment": "POST",
};

const app = new Hono<AppEnv>({ strict: false });

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "DELETE", "QUERY", "SUBSCRIBE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Accept", "Prefer"],
    exposeHeaders: ["Location", "RateLimit", "Retry-After", "Preference-Applied", "X-Mock-Notice"],
    maxAge: 86400,
  }),
);

app.use("*", async (c, next) => {
  await next();
  const reset = 60 - new Date().getUTCSeconds();
  c.res.headers.set("RateLimit", `limit=${RATE_LIMIT}, remaining=${RATE_LIMIT - 1}, reset=${reset}`);
});

app.get("/", (c) =>
  send(c, 200, {
    name: "Train Travel API mock",
    documentation: DOCUMENTATION,
    endpoints: Object.values(OPERATIONS).map((operation) => `${operation.method} ${operation.path}`),
    authentication:
      "Optional. Any Authorization header value works and gives you a private data space; without one you share the public space. Data expires after 24 hours of inactivity.",
    errors_on_demand: "Send `Prefer: code=404` or add `?__code=404` to get any error status the spec documents.",
    test_cards: {
      "4242424242424242": "payment succeeds",
      ...Object.fromEntries(
        Object.entries(DECLINED_CARDS).map(([number, reason]) => [number, `payment fails (${reason})`]),
      ),
    },
  }),
);

app.route("/", stations);
app.route("/", trips);
app.route("/", bookings);

for (const [path, allow] of Object.entries(ALLOWED_METHODS)) {
  app.all(path, (c) =>
    sendProblem(c, problem(405, `${c.req.method} is not supported on this path. Allowed: ${allow}.`), { Allow: allow }),
  );
}

app.notFound((c) =>
  sendProblem(
    c,
    problem(404, `No resource at ${new URL(c.req.url).pathname}. See ${DOCUMENTATION} or GET / for the list.`),
  ),
);

app.onError((error, c) => {
  console.error(error);
  return sendProblem(c, problem(500, "An unexpected error occurred in the mock."));
});

export default app satisfies ExportedHandler<Env>;
