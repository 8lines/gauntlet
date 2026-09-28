import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSubjects, pageContext, sameContext } from "../src/subjects.js";

test("explicit subjects override URL subjects by type and append new types in insertion order", () => {
  const url = [{ type: "customer", values: { customerId: "7" } }, { type: "order", values: { orderId: "9" } }];
  const explicit = new Map([["cart", { cartId: "c" }], ["order", { orderId: "42", paid: true }]]);
  assert.deepEqual(mergeSubjects(url, explicit), [
    { type: "customer", values: { customerId: "7" } },
    { type: "order", values: { orderId: "42", paid: true } },
    { type: "cart", values: { cartId: "c" } },
  ]);
  assert.deepEqual(mergeSubjects(url, new Map()), url);
});

test("context equality is deep and order-sensitive", () => {
  const a = { target: "shop", subjects: [{ type: "order", values: { orderId: "1" } }] };
  assert.equal(sameContext(undefined, a), false);
  assert.equal(sameContext(a, structuredClone(a)), true);
  assert.equal(sameContext(a, { target: "shop", subjects: [{ type: "order", values: { orderId: 1 } }] }), false);
  assert.equal(sameContext(a, { target: "other", subjects: a.subjects }), false);
  const two = { target: "shop", subjects: [{ type: "a", values: {} }, { type: "b", values: {} }] };
  assert.equal(sameContext(two, { target: "shop", subjects: [two.subjects[1]!, two.subjects[0]!] }), false);
});

test("pageContext sends the merged subjects, or none when the merge exceeds the channel limits", () => {
  const url = Array.from({ length: 10 }, (_, i) => ({ type: `u${i}`, values: { id: String(i) } }));
  const explicit = new Map(Array.from({ length: 10 }, (_, i) => [`e${i}`, { id: i }] as const));
  const within = pageContext("shop", url, new Map([["cart", { cartId: "c" }]]));
  assert.equal(within.withinLimits, true);
  assert.equal(within.context.subjects.length, 11);

  const over = pageContext("shop", url, explicit);
  assert.equal(over.withinLimits, false);
  assert.deepEqual(over.context, { target: "shop", subjects: [] });
});
