import { useState } from "react";
import type {
  JsonPointer, OperationDefinition, UiNode, ValidationError,
} from "@8lines/gauntlet-protocol";
import { conditionHolds } from "../../../json-pointer.ts";
import type { FileFieldState, FormValues, FormValuesUpdater } from "../../../form-upload.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field } from "./Field.tsx";

export interface OperationFormProps {
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
    return <p className="text-[13px]/[18px] text-muted-foreground">This operation takes no input.</p>;
  }
  return <UiNodeView node={root} context={props} />;
}

/**
 * The adapter does not have to expose `uiSchema` (the tc-rich-forms@1 profile is optional).
 * In that case the layout is derived from the input schema alone — each property becomes one field.
 */
export function layoutFromSchema(schema: unknown): UiNode | undefined {
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

export function widgetFromSchema(subschema: unknown): "toggle" | "integer" | "number" | "select" | "multi-select" | "json" | "text" {
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
  if (node.type === "tabs") return <FormTabs node={node} context={context} />;

  if (node.type === "group") {
    return (
      <fieldset className={node.label === undefined ? "min-w-0" : "min-w-0 rounded-lg border p-4"}>
        {node.label !== undefined && <legend className="px-1 text-sm/5 font-medium">{node.label}</legend>}
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

/** Pointers of the visible fields below a node, so a tab can tell how many of its fields hold an error. */
function visibleFieldPointers(node: UiNode, values: FormValues): readonly JsonPointer[] {
  if ("visibleWhen" in node && !conditionHolds(node.visibleWhen, values)) return [];
  if (node.type === "field") return [node.pointer];
  if (node.type === "group" || node.type === "columns") return node.children.flatMap((child) => visibleFieldPointers(child, values));
  if (node.type === "tabs") return node.tabs.flatMap((tab) => tab.children.flatMap((child) => visibleFieldPointers(child, values)));
  return [];
}

function FormTabs({ node, context }: { node: Extract<UiNode, { type: "tabs" }>; context: OperationFormProps }) {
  const [activeId, setActiveId] = useState(node.tabs[0]?.id ?? "");
  const current = node.tabs.find((tab) => tab.id === activeId) ?? node.tabs[0];
  return (
    <Tabs value={current?.id ?? ""} onValueChange={setActiveId}>
      <div className="max-w-full overflow-x-auto">
        <TabsList variant="line" className="min-w-max">
          {node.tabs.map((tab) => {
            const pointers = tab.children.flatMap((child) => visibleFieldPointers(child, context.values));
            const errorCount = context.errors.filter((error) => pointers.includes(error.instancePath as JsonPointer)).length;
            return (
              <TabsTrigger key={tab.id} value={tab.id} className="text-sm/5">
                {tab.label}
                {errorCount > 0 && (
                  <span className="text-xs/4 font-normal text-err">{errorCount === 1 ? "1 error" : `${errorCount} errors`}</span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      {node.tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="mt-4 space-y-4">
          {tab.children.map((child, i) => <UiNodeView key={i} node={child} context={context} />)}
        </TabsContent>
      ))}
    </Tabs>
  );
}
