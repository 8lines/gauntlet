import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRoutes, subjectsForPath } from "../src/routes.js";

const routes = compileRoutes([
  { pattern: "/customers/:customerId/orders/:orderId", subjects: { customer: ["customerId"], order: ["orderId"] } },
  { pattern: "/orders/:orderId", subject: "order" },
  { pattern: "/admin/*", subject: "admin" },
])!;

test("first matching rule wins and captures decoded segments", () => {
  assert.deepEqual(subjectsForPath(routes, "/orders/123"), [{ type: "order", values: { orderId: "123" } }]);
  assert.deepEqual(subjectsForPath(routes, "/orders/123/"), [{ type: "order", values: { orderId: "123" } }]);
  assert.deepEqual(subjectsForPath(routes, "/orders/a%2Fb"), [{ type: "order", values: { orderId: "a/b" } }]);
  assert.deepEqual(subjectsForPath(routes, "/customers/7/orders/9"), [
    { type: "customer", values: { customerId: "7" } },
    { type: "order", values: { orderId: "9" } },
  ]);
  assert.deepEqual(subjectsForPath(routes, "/admin"), [{ type: "admin", values: {} }]);
  assert.deepEqual(subjectsForPath(routes, "/admin/a/b"), [{ type: "admin", values: {} }]);
});

test("non-matching, case-different, empty-segment and malformed paths yield no subjects", () => {
  for (const path of ["/", "/orders", "/Orders/1", "/orders//", "/orders/1/extra", "//orders/1", "/orders/%E0%A4%A", `/orders/${"x".repeat(513)}`]) {
    assert.deepEqual(subjectsForPath(routes, path), [], path);
  }
});

test("a later rule matches when an earlier rule fails to decode", () => {
  const fallback = compileRoutes([
    { pattern: "/orders/:orderId", subject: "order" },
    { pattern: "/orders/*", subject: "orders" },
  ])!;
  assert.deepEqual(subjectsForPath(fallback, "/orders/%E0%A4%A"), [{ type: "orders", values: {} }]);
});

test("invalid rule sets are rejected as a whole", () => {
  for (const rules of [
    "nope",
    [{ pattern: "orders/:id", subject: "order" }],
    [{ pattern: "/orders/:id", subject: "bad type" }],
    [{ pattern: "/orders/:id/:id", subject: "order" }],
    [{ pattern: "/orders/:1id", subject: "order" }],
    [{ pattern: "/a/*/b", subject: "a" }],
    [{ pattern: "/orders/:id", subjects: { order: ["missing"] } }],
    [{ pattern: "/orders/:id", subject: "order", subjects: { order: ["id"] } }],
    [{ pattern: "/orders/:id" }],
    [{ pattern: "/orders/:id", subjects: {} }],
  ]) {
    assert.equal(compileRoutes(rules), undefined, JSON.stringify(rules));
  }
  assert.deepEqual(compileRoutes([]), []);
  assert.deepEqual(compileRoutes(undefined), []);
});

test("a trailing slash in a pattern is optional, so / matches the root path", () => {
  const root = compileRoutes([{ pattern: "/", subject: "home" }])!;
  assert.deepEqual(subjectsForPath(root, "/"), [{ type: "home", values: {} }]);
  assert.deepEqual(subjectsForPath(root, "/orders"), []);

  const trailing = compileRoutes([{ pattern: "/orders/:id/", subject: "order" }])!;
  assert.deepEqual(subjectsForPath(trailing, "/orders/1"), [{ type: "order", values: { id: "1" } }]);
  assert.deepEqual(subjectsForPath(trailing, "/orders/1/"), [{ type: "order", values: { id: "1" } }]);
});

test("patterns with empty inner segments are invalid", () => {
  for (const pattern of ["/a//b", "//", "//orders", "/orders//"]) {
    assert.equal(compileRoutes([{ pattern, subject: "a" }]), undefined, pattern);
  }
});

test("rules producing more subjects or values than the channel allows are invalid", () => {
  const params = (count: number) => Array.from({ length: count }, (_, i) => `/:p${i}`).join("");
  assert.notEqual(compileRoutes([{ pattern: params(16), subject: "many" }]), undefined);
  assert.equal(compileRoutes([{ pattern: params(17), subject: "many" }]), undefined);

  const subjects = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, ["id"]]));
  assert.notEqual(compileRoutes([{ pattern: "/x/:id", subjects: subjects(16) }]), undefined);
  assert.equal(compileRoutes([{ pattern: "/x/:id", subjects: subjects(17) }]), undefined);
});
