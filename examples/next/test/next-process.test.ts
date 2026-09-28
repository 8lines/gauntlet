import assert from "node:assert/strict";
import test from "node:test";
import {
  createStartupUrlDetector,
  findLoopbackBaseUrl,
} from "./support/next-process.js";

test("startup URL detection is independent of stdout chunk boundaries", () => {
  let output = "";
  let detected: string | undefined;
  for (const chunk of ["ready http://127.0.0.", "1:43127\n"]) {
    output += chunk;
    detected ??= findLoopbackBaseUrl(output);
  }
  assert.equal(detected, "http://127.0.0.1:43127");
});

test("stderr output cannot split a URL arriving across stdout chunks", () => {
  const detect = createStartupUrlDetector();
  assert.equal(detect("stdout", "ready http://127.0.0."), undefined);
  assert.equal(detect("stderr", "warning: fixture startup\n"), undefined);
  assert.equal(detect("stdout", "1:43127\n"), "http://127.0.0.1:43127");
});
