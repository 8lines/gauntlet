import { useEffect, useState } from "react";
import type {
  DataSourceItem, DataSourceReference, FileReference, InputHandlingRule, JsonPointer,
  OperationDefinition, Problem, UiNode, UploadResponse, ValidationError,
} from "@8lines/gauntlet-protocol";
import { api, type Result } from "./api.ts";
import { readPointer, conditionHolds, writePointer } from "./json-pointer.ts";

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

interface OperationFormProps {
  readonly definition: OperationDefinition;
  readonly targetId: string;
  readonly values: FormValues;
  readonly errors: readonly ValidationError[];
  readonly lockedPointers: readonly JsonPointer[];
  readonly fileStates: ReadonlyMap<JsonPointer, FileFieldState>;
  readonly onChange: (update: FormValuesUpdater) => void;
  readonly onFileState: (pointer: JsonPointer, state: FileFieldState) => void;
}

export function OperationForm(props: OperationFormProps) {
  const root = props.definition.uiSchema?.root ?? layoutFromSchema(props.definition.inputSchema);
  if (root === undefined) {
    return <p className="text-[13px] text-muted-foreground">This operation takes no input.</p>;
  }
  return <UiNodeView node={root} context={props} />;
}

/**
 * The adapter does not have to expose `uiSchema` (the tc-rich-forms@1 profile is optional).
 * In that case the layout is derived from the input schema alone — each property becomes one field.
 */
function layoutFromSchema(schema: unknown): UiNode | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (properties === undefined) return undefined;
  const children: UiNode[] = Object.keys(properties).map((key) => ({
    type: "field",
    pointer: `/${key}` as JsonPointer,
    widget: widgetFromSchema(properties[key]),
  }));
  return children.length === 0 ? undefined : { type: "group", children };
}

function widgetFromSchema(subschema: unknown): "toggle" | "integer" | "number" | "select" | "multi-select" | "json" | "text" {
  const descriptor = subschema as { type?: string; enum?: unknown; items?: unknown } | undefined;
  if (descriptor?.enum !== undefined) return "select";
  switch (descriptor?.type) {
    case "boolean": return "toggle";
    case "integer": return "integer";
    case "number": return "number";
    case "array": return "multi-select";
    case "object": return "json";
    default: return "text";
  }
}

function UiNodeView({ node, context }: { node: UiNode; context: OperationFormProps }) {
  if ("visibleWhen" in node && !conditionHolds(node.visibleWhen, context.values)) return null;

  if (node.type === "field") return <Field node={node} context={context} />;
  if (node.type === "tabs") return <Tabs node={node} context={context} />;

  if (node.type === "group") {
    return (
      <fieldset className={node.label === undefined ? "min-w-0" : "min-w-0 rounded-card border border-border p-4"}>
        {node.label !== undefined && (
          <legend className="px-1 text-[12px] font-semibold text-muted-foreground">{node.label}</legend>
        )}
        <div className="space-y-4">
          {node.children.map((child, i) => <UiNodeView key={i} node={child} context={context} />)}
        </div>
      </fieldset>
    );
  }

  if (node.type === "columns") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {node.children.map((child, i) => <UiNodeView key={i} node={child} context={context} />)}
      </div>
    );
  }

  return null;
}

function Tabs({ node, context }: { node: Extract<UiNode, { type: "tabs" }>; context: OperationFormProps }) {
  const [activeId, setActiveId] = useState(node.tabs[0]?.id ?? "");
  const current = node.tabs.find((tab) => tab.id === activeId) ?? node.tabs[0];
  return (
    <div>
      <div className="max-w-full overflow-x-auto border-b border-border" role="tablist">
        <div className="flex min-w-max gap-1">
        {node.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === current?.id}
            onClick={() => setActiveId(tab.id)}
            className={`-mb-px min-h-11 border-b-2 px-3 py-2 text-[13px] font-medium sm:min-h-0 ${
              tab.id === current?.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
        </div>
      </div>
      <div className="mt-4 space-y-4">
        {current?.children.map((child, i) => <UiNodeView key={i} node={child} context={context} />)}
      </div>
    </div>
  );
}

/** Field label: from uiSchema, otherwise from `title` in the schema, otherwise from the last pointer segment. */
function fieldLabel(node: Extract<UiNode, { type: "field" }>, definition: OperationDefinition): string {
  if (node.label !== undefined) return node.label;
  const path = node.pointer.slice(1).split("/");
  const schema = readPointer(definition.inputSchema, `/properties/${path.join("/properties/")}` as JsonPointer);
  const title = (schema as { title?: unknown } | undefined)?.title;
  return typeof title === "string" ? title : (path.at(-1) ?? node.pointer);
}

function Field({ node, context }: { node: Extract<UiNode, { type: "field" }>; context: OperationFormProps }) {
  const value = readPointer(context.values, node.pointer);
  const locked = context.lockedPointers.includes(node.pointer);
  const disabled = locked || !conditionHolds(node.enabledWhen, context.values);
  const error = context.errors.find((e) => e.instancePath === node.pointer);
  const setValue = (next: unknown) => context.onChange(fieldValueUpdater(node.pointer, next));

  const dataSource = context.definition.dataSources?.find((source) => source.inputPointer === node.pointer);
  const fileRule = fileRuleForPointer(context.definition, node.pointer);
  const fieldId = `field-${node.pointer.replaceAll("/", "-")}`;

  return (
    <div>
      <label id={`${fieldId}-label`} htmlFor={fieldId} className="flex items-center gap-2 text-[13px] font-medium">
        {fieldLabel(node, context.definition)}
        {locked && <span className="rounded-badge bg-wait-bg px-1.5 py-0.5 text-[11px] font-medium text-wait">set by the preset</span>}
      </label>
      {node.help !== undefined && <p className="mt-0.5 text-[12px] text-muted-foreground">{node.help}</p>}

      <div className="mt-1.5">
        <Control
          fieldId={fieldId} node={node} value={value} disabled={disabled} invalid={error !== undefined}
          dataSource={dataSource} targetId={context.targetId} values={context.values}
          schema={context.definition.inputSchema} setValue={setValue}
          fileRule={fileRule} fileState={context.fileStates.get(node.pointer) ?? { pending: 0 }}
          onFileState={(state) => context.onFileState(node.pointer, state)}
        />
      </div>

      {error !== undefined && <p className="mt-1 text-[12px] text-stop">{error.message}</p>}
    </div>
  );
}

const FIELD_CLASS =
  "field-control w-full rounded-control border bg-background px-3 py-2 text-base shadow-control transition-colors disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground sm:text-[13px]";

function Control(props: {
  readonly fieldId: string;
  readonly node: Extract<UiNode, { type: "field" }>;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly dataSource: DataSourceReference | undefined;
  readonly targetId: string;
  readonly values: Record<string, unknown>;
  readonly schema: unknown;
  readonly setValue: (v: unknown) => void;
  readonly fileRule: Extract<InputHandlingRule, { kind: "file" }> | undefined;
  readonly fileState: FileFieldState;
  readonly onFileState: (state: FileFieldState) => void;
}) {
  const border = props.invalid ? "border-stop" : "border-input";
  const common = { id: props.fieldId, "aria-invalid": props.invalid || undefined, disabled: props.disabled, className: `${FIELD_CLASS} ${border}` };
  const text = typeof props.value === "string" ? props.value : "";

  switch (props.node.widget) {
    case "toggle":
      return (
        <button
          id={props.fieldId} type="button" disabled={props.disabled} onClick={() => props.setValue(props.value !== true)}
          aria-pressed={props.value === true}
          className="icon-button disabled:opacity-50"
        >
          <span className="switch-track" data-checked={props.value === true} aria-hidden="true">
            <span className="switch-thumb" />
          </span>
        </button>
      );

    case "textarea":
      return <textarea {...common} rows={3} value={text} onChange={(e) => props.setValue(e.target.value)} />;

    case "integer":
    case "number":
      return (
        <input
          {...common} type="number" inputMode={props.node.widget === "integer" ? "numeric" : "decimal"}
          value={typeof props.value === "number" ? String(props.value) : ""}
          onChange={(e) => props.setValue(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );

    case "secret":
      return <input {...common} type="password" autoComplete="off" value={text} onChange={(e) => props.setValue(e.target.value)} />;

    case "date":
      return <input {...common} type="date" value={text} onChange={(e) => props.setValue(e.target.value)} />;

    case "date-time":
      return <input {...common} type="datetime-local" value={text} onChange={(e) => props.setValue(e.target.value)} />;

    case "select":
      return <Choice {...props} multiple={false} />;

    case "multi-select":
      return <Choice {...props} multiple />;

    case "autocomplete":
      return props.dataSource === undefined
        ? <input {...common} value={text} onChange={(e) => props.setValue(e.target.value)} />
        : <Autocomplete {...props} dataSource={props.dataSource} />;

    case "json":
    case "code":
      return (
        <textarea
          {...common} rows={5} className={`${FIELD_CLASS} ${border} font-mono text-[12px]`}
          value={typeof props.value === "string" ? props.value : JSON.stringify(props.value ?? {}, null, 2)}
          onChange={(e) => { try { props.setValue(JSON.parse(e.target.value)); } catch { props.setValue(e.target.value); } }}
        />
      );

    case "file":
      return <FileInput {...props} />;

    default:
      return <input {...common} value={text} onChange={(e) => props.setValue(e.target.value)} />;
  }
}

function FileInput(props: Parameters<typeof Control>[0]) {
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

  return (
    <div className="space-y-2">
      <input
        id={props.fieldId}
        type="file"
        accept={rule?.mediaTypes?.join(",")}
        multiple={rule?.multiple ?? false}
        disabled={props.disabled || busy || rule === undefined}
        className={`file-control field-control w-full rounded-control border bg-background px-1.5 py-1 text-base shadow-control disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground sm:text-[13px] ${props.invalid || props.fileState.problem !== undefined ? "border-stop" : "border-input"}`}
        onChange={(event) => void selectFiles([...(event.currentTarget.files ?? [])])}
      />
      {busy && (
        <p className="text-[12px] text-muted-foreground" aria-live="polite">
          Uploading {props.fileState.pending === 1 ? "file…" : `${props.fileState.pending} files…`}
        </p>
      )}
      {references.length > 0 && !busy && (
        <p className="text-[12px] text-muted-foreground">
          {references.map(({ name }) => name).join(", ")}
        </p>
      )}
      {props.fileState.problem !== undefined && (
        <div className="rounded-control border border-stop-bd bg-stop-bg p-2" role="alert">
          <p className="text-[12px] font-medium text-stop">{props.fileState.problem.title}</p>
          {props.fileState.problem.detail !== undefined && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">{props.fileState.problem.detail}</p>
          )}
        </div>
      )}
    </div>
  );
}

function isFileReference(value: unknown): value is FileReference {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "file";
}

/** The input schema's `enum` for the field at the given pointer. */
function allowedValues(schema: unknown, pointer: JsonPointer): readonly string[] {
  const path = pointer.slice(1).split("/");
  const subschema = readPointer(schema, `/properties/${path.join("/properties/")}` as JsonPointer);
  const descriptor = subschema as { enum?: unknown; items?: { enum?: unknown } } | undefined;
  const allowed = descriptor?.enum ?? descriptor?.items?.enum;
  return Array.isArray(allowed) ? allowed.filter((v): v is string => typeof v === "string") : [];
}

function Choice(props: Parameters<typeof Control>[0] & { readonly multiple: boolean }) {
  const options = allowedValues(props.schema, props.node.pointer);
  const selected = Array.isArray(props.value) ? (props.value as string[]) : [];

  if (!props.multiple) {
    return (
      <select
        id={props.fieldId} disabled={props.disabled} value={typeof props.value === "string" ? props.value : ""}
        onChange={(e) => props.setValue(e.target.value)}
        className={`${FIELD_CLASS} ${props.invalid ? "border-stop" : "border-input"}`}
      >
        <option value="">— select —</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  return (
    <div
      id={props.fieldId}
      role="group"
      aria-labelledby={`${props.fieldId}-label`}
      className="flex flex-wrap gap-1.5 rounded-control border border-input bg-background p-2"
    >
      {options.map((o) => {
        const isSelected = selected.includes(o);
        return (
          <button
            key={o} type="button" disabled={props.disabled}
            aria-pressed={isSelected}
            onClick={() => props.setValue(isSelected ? selected.filter((x) => x !== o) : [...selected, o])}
            className={`min-h-11 rounded-badge px-2 py-0.5 text-[12px] sm:min-h-0 ${isSelected ? "bg-info-bg text-info" : "bg-muted text-muted-foreground"}`}
          >
            {o}
          </button>
        );
      })}
      {options.length === 0 && <span className="px-1 text-[12px] text-muted-foreground">The schema lists no allowed values.</span>}
    </div>
  );
}

function Autocomplete(props: Parameters<typeof Control>[0] & { readonly dataSource: DataSourceReference }) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<readonly DataSourceItem[]>([]);
  const [loading, setLoading] = useState(false);

  /* Changing a field the data source depends on invalidates the list — these are the `dependencyPointers`. */
  const dependencies = JSON.stringify(props.dataSource.dependencyPointers.map((p) => readPointer(props.values, p)));

  /*
   * While a field the list depends on is empty, querying makes no sense:
   * the adapter would reject the query as incomplete. Instead of showing an error, we wait.
   */
  const missingDependencies = props.dataSource.dependencyPointers.filter((p) => {
    const value = readPointer(props.values, p);
    return value === undefined || value === null || value === "";
  });

  useEffect(() => {
    if (missingDependencies.length > 0) { setItems([]); setLoading(false); return; }
    let active = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      const dependencyValues: Record<string, unknown> = {};
      for (const p of props.dataSource.dependencyPointers) dependencyValues[p] = readPointer(props.values, p);
      const result = await api.queryDataSource(props.targetId, props.dataSource.id, {
        search, limit: 20, dependencies: dependencyValues,
        context: { requestId: `dashboard-${Date.now()}`, target: { id: props.targetId } },
      });
      if (!active) return;
      setItems(result.ok ? result.data.items : []);
      setLoading(false);
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [search, dependencies, missingDependencies.length, props.dataSource.id, props.targetId]);

  const selectedItem = items.find((item) => item.value === props.value);

  return (
    <div className={`rounded-control border bg-background ${props.invalid ? "border-stop" : "border-input"}`}>
      <input
        id={props.fieldId} disabled={props.disabled || missingDependencies.length > 0}
        value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder={selectedItem?.label ?? (missingDependencies.length > 0 ? "Waiting for a selection above…" : "Start typing to search…")}
        className="w-full rounded-t-control bg-transparent px-3 py-2 text-[13px] outline-none disabled:text-muted-foreground"
      />
      <div className="max-h-52 overflow-y-auto border-t border-border">
        {missingDependencies.length > 0 && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">
            First fill in the field this list depends on.
          </p>
        )}
        {missingDependencies.length === 0 && loading && <p className="px-3 py-2 text-[12px] text-muted-foreground">Searching…</p>}
        {missingDependencies.length === 0 && !loading && items.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">No matching items.</p>
        )}
        {items.map((item) => (
          <button
            key={item.value} type="button" disabled={item.disabled === true || props.disabled}
            onClick={() => { props.setValue(item.value); setSearch(""); }}
            className={`flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted disabled:opacity-50 ${item.value === props.value ? "bg-muted" : ""}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px]">{item.label}</span>
              {item.description !== undefined && <span className="block text-[12px] text-muted-foreground">{item.description}</span>}
            </span>
            {item.group !== undefined && <span className="shrink-0 rounded-badge bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.group}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
