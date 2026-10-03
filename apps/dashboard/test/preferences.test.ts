import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTheme } from "../src/preferences.ts";

test("explicit themes ignore the system preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("system theme follows the operating system", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});
