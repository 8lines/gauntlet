import { Lock } from "lucide-react";
import type {
  DataSourceReference, InputHandlingRule, JsonPointer, OperationDefinition, UiNode,
} from "@8lines/gauntlet-protocol";
import { readPointer, conditionHolds } from "../../../json-pointer.ts";
import { fieldValueUpdater, fileRuleForPointer, type FileFieldState } from "../../../form-upload.ts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Autocomplete } from "./Autocomplete.tsx";
import { Choice } from "./Choice.tsx";
import { FileInput } from "./FileInput.tsx";
import type { OperationFormProps } from "./OperationForm.tsx";

export interface ControlProps {
  readonly fieldId: string;
  readonly label: string;
  readonly node: Extract<UiNode, { type: "field" }>;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly required: boolean;
  /** Ids of the help and error text, joined for `aria-describedby`. */
  readonly describedBy: string | undefined;
  readonly dataSource: DataSourceReference | undefined;
  readonly targetId: string;
  readonly values: Record<string, unknown>;
  readonly schema: unknown;
  readonly setValue: (v: unknown) => void;
  readonly fileRule: Extract<InputHandlingRule, { kind: "file" }> | undefined;
  readonly fileState: FileFieldState;
  readonly onFileState: (state: FileFieldState) => void;
}

/** Field label: from uiSchema, otherwise from `title` in the schema, otherwise from the last pointer segment. */
function fieldLabel(node: Extract<UiNode, { type: "field" }>, definition: OperationDefinition): string {
  if (node.label !== undefined) return node.label;
  const path = node.pointer.slice(1).split("/");
  const schema = readPointer(definition.inputSchema, `/properties/${path.join("/properties/")}` as JsonPointer);
  const title = (schema as { title?: unknown } | undefined)?.title;
  return typeof title === "string" ? title : (path.at(-1) ?? node.pointer);
}

/** Whether the parent object schema lists the field in `required`. */
function isRequired(schema: unknown, pointer: JsonPointer): boolean {
  const path = pointer.slice(1).split("/");
  const name = path.pop();
  const parent = path.length === 0
    ? schema
    : readPointer(schema, `/properties/${path.join("/properties/")}` as JsonPointer);
  const required = (parent as { required?: unknown } | undefined)?.required;
  return name !== undefined && Array.isArray(required) && required.includes(name);
}

export function Field({ node, context }: { node: Extract<UiNode, { type: "field" }>; context: OperationFormProps }) {
  const value = readPointer(context.values, node.pointer);
  const locked = context.lockedPointers.includes(node.pointer);
  const disabled = locked || !conditionHolds(node.enabledWhen, context.values);
  const error = context.errors.find((e) => e.instancePath === node.pointer);
  const setValue = (next: unknown) => context.onChange(fieldValueUpdater(node.pointer, next));

  const dataSource = context.definition.dataSources?.find((source) => source.inputPointer === node.pointer);
  const fileRule = fileRuleForPointer(context.definition, node.pointer);
  const fieldId = `field-${node.pointer.replaceAll("/", "-")}`;
  const helpId = `${fieldId}-help`;
  const lockedId = `${fieldId}-locked`;
  const errorId = `${fieldId}-error`;
  const describedBy = [
    node.help !== undefined ? helpId : undefined,
    locked ? lockedId : undefined,
    error !== undefined ? errorId : undefined,
  ]
    .filter((id) => id !== undefined)
    .join(" ") || undefined;
  const label = fieldLabel(node, context.definition);
  const required = isRequired(context.definition.inputSchema, node.pointer);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Label id={`${fieldId}-label`} htmlFor={fieldId} className="text-sm/5 font-medium">
          {label}
          {required && <span className="text-err" aria-hidden="true">*</span>}
        </Label>
        {locked && (
          <span id={lockedId} className="inline-flex items-center gap-1 text-xs/4 text-muted-foreground">
            <Lock className="size-3" aria-hidden="true" />
            Locked by preset
          </span>
        )}
      </div>
      {node.help !== undefined && <p id={helpId} className="text-[13px]/[18px] text-muted-foreground">{node.help}</p>}

      <Control
        fieldId={fieldId} label={label} node={node} value={value} disabled={disabled}
        invalid={error !== undefined} required={required} describedBy={describedBy}
        dataSource={dataSource} targetId={context.targetId} values={context.values}
        schema={context.definition.inputSchema} setValue={setValue}
        fileRule={fileRule} fileState={context.fileStates.get(node.pointer) ?? { pending: 0 }}
        onFileState={(state) => context.onFileState(node.pointer, state)}
      />

      {error !== undefined && <p id={errorId} className="text-[13px]/[18px] text-err">{error.message}</p>}
    </div>
  );
}

function Control(props: ControlProps) {
  const common = {
    id: props.fieldId,
    "aria-invalid": props.invalid || undefined,
    "aria-describedby": props.describedBy,
    "aria-required": props.required || undefined,
    disabled: props.disabled,
  };
  const text = typeof props.value === "string" ? props.value : "";

  switch (props.node.widget) {
    case "toggle":
      return (
        <Switch
          id={props.fieldId} aria-label={props.label} aria-describedby={props.describedBy}
          disabled={props.disabled} checked={props.value === true}
          onCheckedChange={(checked) => props.setValue(checked)}
        />
      );

    case "textarea":
      return <Textarea {...common} rows={3} value={text} onChange={(e) => props.setValue(e.target.value)} />;

    case "integer":
    case "number":
      return (
        <Input
          {...common} type="number" inputMode={props.node.widget === "integer" ? "numeric" : "decimal"}
          value={typeof props.value === "number" ? String(props.value) : ""}
          onChange={(e) => props.setValue(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );

    case "secret":
      return <Input {...common} type="password" autoComplete="off" value={text} onChange={(e) => props.setValue(e.target.value)} />;

    case "date":
      return <Input {...common} type="date" value={text} onChange={(e) => props.setValue(e.target.value)} />;

    case "date-time":
      return <Input {...common} type="datetime-local" value={text} onChange={(e) => props.setValue(e.target.value)} />;

    case "select":
      return <Choice {...props} multiple={false} />;

    case "multi-select":
      return <Choice {...props} multiple />;

    case "autocomplete":
      return props.dataSource === undefined
        ? <Input {...common} value={text} onChange={(e) => props.setValue(e.target.value)} />
        : <Autocomplete {...props} dataSource={props.dataSource} />;

    case "json":
    case "code":
      return (
        <Textarea
          {...common} rows={5} className="font-mono text-xs/4 md:text-xs/4"
          value={typeof props.value === "string" ? props.value : JSON.stringify(props.value ?? {}, null, 2)}
          onChange={(e) => { try { props.setValue(JSON.parse(e.target.value)); } catch { props.setValue(e.target.value); } }}
        />
      );

    case "file":
      return <FileInput {...props} />;

    default:
      return <Input {...common} value={text} onChange={(e) => props.setValue(e.target.value)} />;
  }
}
