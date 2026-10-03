import type {
  FileReference, InputHandlingRule, JsonPointer, OperationDefinition, Problem, UploadResponse,
} from "@8lines/gauntlet-protocol";
import type { Result } from "./api.ts";
import { writePointer } from "./json-pointer.ts";

export interface FileFieldState {
  readonly pending: number;
  readonly problem?: Problem;
}

export type FormValues = Record<string, unknown>;
export type FormValuesUpdater = (current: FormValues) => FormValues;

export function fieldValueUpdater(pointer: JsonPointer, value: unknown): FormValuesUpdater {
  return (current) => writePointer(current, pointer, value);
}

export class UploadProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
    this.name = "UploadProblem";
  }
}

type UploadFile = (file: File) => Promise<Result<UploadResponse>>;

/** Uploads one request at a time so the resulting references retain selection order. */
export async function uploadFiles(
  files: readonly File[],
  multiple: boolean,
  upload: UploadFile,
  onPending: (pending: number) => void = () => undefined,
): Promise<FileReference | readonly FileReference[]> {
  const selected = multiple ? files : files.slice(0, 1);
  const references: FileReference[] = [];
  try {
    for (const [index, file] of selected.entries()) {
      onPending(selected.length - index);
      const result = await upload(file);
      if (!result.ok) throw new UploadProblem(result.problem);
      references.push(result.data.file);
    }
  } finally {
    onPending(0);
  }
  return multiple ? references : references[0]!;
}

export function fileRuleForPointer(
  definition: OperationDefinition,
  pointer: JsonPointer,
): Extract<InputHandlingRule, { kind: "file" }> | undefined {
  const schemaPointer = pointer === ""
    ? ""
    : `/properties/${pointer.slice(1).split("/").join("/properties/")}`;
  return definition.inputHandling?.rules.find(
    (rule): rule is Extract<InputHandlingRule, { kind: "file" }> =>
      rule.kind === "file" && rule.schemaPointer === schemaPointer,
  );
}
