import { useEffect, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { DataSourceItem, DataSourceReference } from "@8lines/gauntlet-protocol";
import { api } from "../../../api.ts";
import { readPointer } from "../../../json-pointer.ts";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ControlProps } from "./Field.tsx";

export function Autocomplete(props: ControlProps & { readonly dataSource: DataSourceReference }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<readonly DataSourceItem[]>([]);
  const [picked, setPicked] = useState<DataSourceItem | undefined>(undefined);
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
  const waiting = missingDependencies.length > 0;

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

  const selectedItem = items.find((item) => item.value === props.value)
    ?? (picked?.value === props.value ? picked : undefined);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };
  const triggerText = selectedItem?.label ?? (waiting ? "Waiting for a selection above" : "Start typing to search");

  return (
    <Popover open={open && !waiting} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={props.fieldId} type="button" variant="outline" role="combobox" aria-expanded={open && !waiting}
          aria-invalid={props.invalid || undefined} aria-describedby={props.describedBy}
          aria-required={props.required || undefined}
          disabled={props.disabled || waiting}
          className={cn("w-full justify-between font-normal", selectedItem === undefined && "text-muted-foreground")}
        >
          <span className="truncate">{triggerText}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder="Start typing to search" aria-label={`Search ${props.label}`} />
          <CommandList>
            {loading && <p className="px-3 py-2 text-sm/5 text-muted-foreground" role="status">Searching</p>}
            {!loading && <CommandEmpty>No matching items.</CommandEmpty>}
            {items.map((item) => (
              <CommandItem
                key={item.value} value={item.value} disabled={item.disabled === true || props.disabled}
                onSelect={() => { props.setValue(item.value); setPicked(item); handleOpenChange(false); }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm/5">{item.label}</span>
                  {item.description !== undefined && <span className="block text-xs/4 text-muted-foreground">{item.description}</span>}
                </span>
                {item.group !== undefined && <span className="shrink-0 text-xs/4 text-muted-foreground">{item.group}</span>}
                {item.value === props.value && <Check className="size-4 shrink-0" aria-hidden="true" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
