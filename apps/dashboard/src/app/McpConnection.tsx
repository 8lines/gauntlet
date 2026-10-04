import { useId, useState } from "react";
import { ChevronDown, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Shown in the snippet in place of a real API token, which the dashboard never has. */
const API_TOKEN_PLACEHOLDER = "<API token>";

function mcpEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" || url.password !== "" ||
      url.search !== "" || url.hash !== "" ||
      !url.pathname.endsWith("/mcp")
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function McpConnection({ authenticated = false }: { authenticated?: boolean }) {
  const [url, setUrl] = useState(() => import.meta.env.DEV
    ? __GAUNTLET_DEV_MCP_URL__
    : new URL("/mcp", globalThis.location.href).href);
  const [copyMessage, setCopyMessage] = useState("");
  const urlId = useId();
  const hintId = useId();
  const errorId = useId();
  const endpoint = mcpEndpoint(url);
  const configuration = endpoint === undefined
    ? undefined
    : JSON.stringify({
        mcpServers: {
          gauntlet: authenticated
            ? { url: endpoint, headers: { Authorization: `Bearer ${API_TOKEN_PLACEHOLDER}` } }
            : { url: endpoint },
        },
      }, null, 2);

  const copyConfiguration = async () => {
    if (configuration === undefined) return;
    try {
      await navigator.clipboard.writeText(configuration);
      setCopyMessage("Configuration copied.");
    } catch {
      setCopyMessage("Could not copy. Select the configuration and copy it manually.");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <Label htmlFor={urlId} className="text-sm/5">MCP server URL</Label>
          <span className="text-[13px]/[18px] text-muted-foreground">Transport: Streamable HTTP</span>
        </div>
        <Input
          id={urlId}
          type="url"
          value={url}
          aria-invalid={endpoint === undefined || undefined}
          aria-describedby={endpoint === undefined ? `${errorId} ${hintId}` : hintId}
          onChange={(event) => {
            setUrl(event.target.value);
            setCopyMessage("");
          }}
          spellCheck={false}
          className="font-mono text-sm/5"
        />
        {endpoint === undefined && (
          <p id={errorId} className="text-[13px]/[18px] text-destructive">Enter an HTTP or HTTPS URL ending in /mcp.</p>
        )}
        <p id={hintId} className="text-[13px]/[18px] text-muted-foreground">
          Use the private address your MCP client can reach. If the dashboard runs separately, enter the control plane URL here.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm/5 font-medium">Client configuration</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={configuration === undefined}
            onClick={() => void copyConfiguration()}
          >
            <Copy aria-hidden="true" />
            Copy configuration
          </Button>
        </div>
        {configuration !== undefined && (
          <pre className="rounded-lg border bg-muted px-4 py-3 font-mono text-xs/4 break-all whitespace-pre-wrap text-foreground select-text">{configuration}</pre>
        )}
        <p className="text-[13px]/[18px] text-muted-foreground">
          Paste this into clients that use <code className="font-mono text-xs/4 text-foreground">mcpServers</code> JSON. In other clients, enter the URL above and select Streamable HTTP.
        </p>
        {authenticated && (
          <p className="text-[13px]/[18px] text-muted-foreground">
            This Gauntlet requires authentication. Replace <code className="font-mono text-xs/4 text-foreground">&lt;API token&gt;</code> with a token from the <code className="font-mono text-xs/4 text-foreground">auth.tokens</code> configuration; create one with <code className="font-mono text-xs/4 text-foreground">node dist/auth-cli.js create-token</code>.
          </p>
        )}
        <p role="status" className="min-h-[18px] text-[13px]/[18px] text-muted-foreground">{copyMessage}</p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        <p className="text-[13px]/[18px] text-muted-foreground">
          Enable MCP on the Gauntlet server before using this connection. The client must be able to reach its private address.
        </p>
        <Collapsible className="group/setup">
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md text-sm/5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            Server setup
            <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-data-[state=open]/setup:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 flex flex-col gap-2 text-[13px]/[18px] text-muted-foreground">
            <p><span className="font-medium text-foreground">Local server:</span> set <code className="font-mono text-xs/4 text-foreground">GAUNTLET_MCP_ENABLED=true</code> before starting it.</p>
            <p><span className="font-medium text-foreground">Compose:</span> set that value in the installation’s <code className="font-mono text-xs/4 text-foreground">.env</code>, then run <code className="font-mono text-xs/4 text-foreground">./gauntlet up -d --wait</code> there.</p>
            <p><span className="font-medium text-foreground">Helm:</span> set <code className="font-mono text-xs/4 text-foreground">mcp.enabled</code> to <code className="font-mono text-xs/4 text-foreground">true</code> in the values file, then upgrade the release.</p>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
