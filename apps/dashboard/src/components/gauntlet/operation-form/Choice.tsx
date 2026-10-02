import type { JsonPointer } from "@8lines/gauntlet-protocol";
import { readPointer } from "../../../json-pointer.ts";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ControlProps } from "./Field.tsx";

/** The input schema's `enum` for the field at the given pointer. */
function allowedValues(schema: unknown, pointer: JsonPointer): readonly string[] {
  const path = pointer.slice(1).split("/");
  const subschema = readPointer(schema, `/properties/${path.join("/properties/")}` as JsonPointer);
  const descriptor = subschema as { enum?: unknown; items?: { enum?: unknown } } | undefined;
  const allowed = descriptor?.enum ?? descriptor?.items?.enum;
  return Array.isArray(allowed) ? allowed.filter((v): v is string => typeof v === "string") : [];
}

/* Radix SelectItem rejects an empty value, so "no value" and an enum value of "" use sentinels. */
const NO_VALUE = "__gauntlet_no_value__";
const EMPTY_VALUE = "__gauntlet_empty__";
const EMPTY_LABEL = "Empty value";

export function Choice(props: ControlProps & { readonly multiple: boolean }) {
  const options = allowedValues(props.schema, props.node.pointer);
  const selected = Array.isArray(props.value) ? (props.value as string[]) : [];

  if (!props.multiple) {
    return (
      <Select
        value={typeof props.value === "string" ? (props.value === "" ? EMPTY_VALUE : props.value) : ""}
        onValueChange={(next) => props.setValue(next === NO_VALUE ? undefined : next === EMPTY_VALUE ? "" : next)}
        disabled={props.disabled}
      >
        <SelectTrigger
          id={props.fieldId} className="w-full" aria-invalid={props.invalid || undefined}
          aria-describedby={props.describedBy} aria-required={props.required || undefined}
        >
          <SelectValue placeholder="Select a value" />
        </SelectTrigger>
        <SelectContent>
          {!props.required && <SelectItem value={NO_VALUE}>No value</SelectItem>}
          {options.map((o) => <SelectItem key={o} value={o === "" ? EMPTY_VALUE : o}>{o === "" ? EMPTY_LABEL : o}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }

  return (
    <div
      id={props.fieldId}
      role="group"
      aria-labelledby={`${props.fieldId}-label`}
      aria-describedby={props.describedBy}
      aria-invalid={props.invalid || undefined}
      className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border p-3 aria-invalid:border-err"
    >
      {options.map((o, index) => {
        const isSelected = selected.includes(o);
        const optionId = `${props.fieldId}-option-${index}`;
        return (
          <div key={o} className="flex items-center gap-2">
            <Checkbox
              id={optionId} disabled={props.disabled} checked={isSelected}
              onCheckedChange={() => props.setValue(isSelected ? selected.filter((x) => x !== o) : [...selected, o])}
            />
            <Label htmlFor={optionId} className="text-sm/5 font-normal">{o === "" ? EMPTY_LABEL : o}</Label>
          </div>
        );
      })}
      {options.length === 0 && <span className="text-xs/4 text-muted-foreground">The schema lists no allowed values.</span>}
    </div>
  );
}
