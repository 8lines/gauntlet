export function StatStrip({ items }: { items: readonly { label: string; value: string | number; detail?: string }[] }) {
  return (
    <dl className="grid gap-6 border-y py-4 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[13px]/[18px] text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 text-xl/7 font-semibold tabular-nums">{item.value}</dd>
          {item.detail !== undefined && <dd className="mt-1 text-[13px]/[18px] text-muted-foreground">{item.detail}</dd>}
        </div>
      ))}
    </dl>
  );
}
