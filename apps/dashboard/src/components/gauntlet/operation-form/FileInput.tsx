import type { FileReference, Problem } from "@8lines/gauntlet-protocol";
import { api } from "../../../api.ts";
import { UploadProblem, uploadFiles } from "../../../form-upload.ts";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ProblemAlert } from "../ProblemAlert.tsx";
import type { ControlProps } from "./Field.tsx";

function isFileReference(value: unknown): value is FileReference {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "file";
}

export function FileInput(props: ControlProps) {
  const rule = props.fileRule;
  const busy = props.fileState.pending > 0;
  const selectFiles = async (files: readonly File[]) => {
    if (rule === undefined || files.length === 0) return;
    try {
      const reference = await uploadFiles(
        files,
        rule.multiple,
        (file) => api.uploadFile(props.targetId, file),
        (pending) => props.onFileState({ pending }),
      );
      props.setValue(reference);
      props.onFileState({ pending: 0 });
    } catch (error) {
      const problem = error instanceof UploadProblem
        ? error.problem
        : {
            type: "urn:gauntlet:problem:upload-failed",
            title: "Could not upload the file",
            status: 0,
          } satisfies Problem;
      props.onFileState({ pending: 0, problem });
    }
  };
  const references = Array.isArray(props.value)
    ? props.value.filter(isFileReference)
    : isFileReference(props.value) ? [props.value] : [];
  const uploading = props.fileState.pending === 1 ? "Uploading file" : `Uploading ${props.fileState.pending} files`;

  return (
    <div className="space-y-2">
      <Input
        id={props.fieldId}
        type="file"
        accept={rule?.mediaTypes?.join(",")}
        multiple={rule?.multiple ?? false}
        disabled={props.disabled || busy || rule === undefined}
        aria-invalid={props.invalid || props.fileState.problem !== undefined || undefined}
        aria-describedby={props.describedBy}
        aria-required={props.required || undefined}
        className="h-auto py-1.5"
        onChange={(event) => void selectFiles([...(event.currentTarget.files ?? [])])}
      />
      {busy && (
        <div className="space-y-1.5" aria-live="polite">
          <p className="text-xs/4 text-muted-foreground">{uploading}</p>
          <Progress aria-label={uploading} className="h-1" />
        </div>
      )}
      {references.length > 0 && !busy && (
        <p className="text-xs/4 text-muted-foreground">
          {references.map(({ name }) => name).join(", ")}
        </p>
      )}
      {props.fileState.problem !== undefined && <ProblemAlert problem={props.fileState.problem} />}
    </div>
  );
}
