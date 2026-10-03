import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileReference, OperationDefinition, Problem } from "@8lines/gauntlet-protocol";
import operationDocument from "@8lines/gauntlet-protocol/fixtures/v1/operation.valid.json" with { type: "json" };
import {
  fieldValueUpdater,
  fileRuleForPointer,
  UploadProblem,
  uploadFiles,
} from "../src/form-upload.ts";

const validFileReference: FileReference = {
  kind: "file",
  uploadId: "upload-1",
  name: "x.txt",
  mediaType: "text/plain",
  sizeBytes: 1,
  expiresAt: "2026-09-03T12:00:00Z",
};

test("an uploaded file stores only the returned FileReference", async () => {
  const reference = await uploadFiles([new File(["x"], "x.txt")], false, async () => ({
    ok: true,
    data: { file: validFileReference },
  }));

  assert.deepEqual(reference, validFileReference);
});

test("a file field resolves its instance pointer to the matching schema rule", () => {
  const rule = fileRuleForPointer(operationDocument as OperationDefinition, "/attachment");

  assert.equal(rule?.kind, "file");
  assert.equal(rule?.schemaPointer, "/properties/attachment");
  assert.deepEqual(rule?.mediaTypes, ["application/pdf", "text/plain"]);
});

test("an upload completion applies to the latest form state and preserves an intervening edit", () => {
  const completeUpload = fieldValueUpdater("/attachment", validFileReference);
  const stateAfterInterveningEdit = {
    message: "edited while upload was pending",
  };

  assert.deepEqual(completeUpload(stateAfterInterveningEdit), {
    message: "edited while upload was pending",
    attachment: validFileReference,
  });
});

test("multiple file mode uploads sequentially and preserves selected order", async () => {
  const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
  const started: string[] = [];
  let active = 0;
  let maximumActive = 0;

  const result = await uploadFiles(files, true, async (file) => {
    started.push(file.name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return {
      ok: true,
      data: { file: { ...validFileReference, uploadId: file.name, name: file.name } },
    };
  });

  assert.deepEqual((result as readonly FileReference[]).map(({ name }) => name), ["a.txt", "b.txt"]);
  assert.deepEqual(started, ["a.txt", "b.txt"]);
  assert.equal(maximumActive, 1);
});

test("a failed upload exposes only its sanitized Problem", async () => {
  const problem: Problem = {
    type: "urn:gauntlet:problem:upload-rejected",
    title: "Upload rejected",
    status: 413,
  };

  await assert.rejects(
    uploadFiles([new File(["x"], "x.txt")], false, async () => ({ ok: false, problem })),
    (error) => error instanceof UploadProblem && error.problem === problem,
  );
});
