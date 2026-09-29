import { useId, useState } from "react";
import { Button } from "./ui.tsx";

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

export function McpConnectionSettings() {
  const [url, setUrl] = useState(() => import.meta.env.DEV
    ? __GAUNTLET_DEV_MCP_URL__
    : new URL("/mcp", globalThis.location.href).href);
  const [copyMessage, setCopyMessage] = useState("");
  const hintId = useId();
  const errorId = useId();
  const endpoint = mcpEndpoint(url);
  const configuration = endpoint === undefined
    ? undefined
    : JSON.stringify({ mcpServers: { gauntlet: { url: endpoint } } }, null, 2);

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
    <section aria-label="MCP connection">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">MCP connection</h3>
        <span className="rounded-badge bg-info-bg px-2 py-1 text-[11px] font-medium text-info">Streamable HTTP</span>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Connect an AI client to this Gauntlet instance.
      </p>

      <label htmlFor="mcp-server-url" className="mt-5 block text-[12px] font-medium">MCP server URL</label>
      <input
        id="mcp-server-url"
        type="url"
        value={url}
        aria-invalid={endpoint === undefined || undefined}
        aria-describedby={endpoint === undefined ? `${hintId} ${errorId}` : hintId}
        onChange={(event) => {
          setUrl(event.target.value);
          setCopyMessage("");
        }}
        spellCheck={false}
        className="field-control mono-text mt-2 w-full rounded-control border border-input bg-background px-3 py-2 text-[12px] shadow-control"
      />
      {endpoint === undefined && (
        <p id={errorId} className="mt-2 text-[12px] text-stop">Enter an HTTP or HTTPS URL ending in /mcp.</p>
      )}
      <p id={hintId} className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        Use the private address your MCP client can reach. If the dashboard runs separately, enter the control plane URL here.
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-medium">Client configuration</p>
        <Button type="button" disabled={configuration === undefined} onClick={() => void copyConfiguration()}>Copy configuration</Button>
      </div>
      {configuration !== undefined && (
        <pre className="mono-text mt-2 whitespace-pre-wrap break-all rounded-card border border-border bg-muted px-4 py-3 text-[11px] leading-relaxed text-foreground select-text">{configuration}</pre>
      )}
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
        Paste this into clients that use <code className="mono-text">mcpServers</code> JSON. In other clients, enter the URL above and select Streamable HTTP.
      </p>
      <p role="status" className="mt-2 min-h-5 text-[12px] text-muted-foreground">{copyMessage}</p>

      <div className="mt-3 rounded-card border border-info-bd bg-info-bg/40 p-4 text-[12px] leading-relaxed text-muted-foreground">
        <p>Enable MCP on the Gauntlet server before using this connection. The client must be able to reach its private address.</p>
        <details className="mt-3">
          <summary className="font-medium text-foreground">Server setup</summary>
          <div className="mt-3 space-y-2">
            <p><strong>Local server:</strong> set <code className="mono-text text-foreground">GAUNTLET_MCP_ENABLED=true</code> before starting it.</p>
            <p><strong>Compose:</strong> set that value in the installation’s <code className="mono-text text-foreground">.env</code>, then run <code className="mono-text text-foreground">./gauntlet up -d --wait</code> there.</p>
            <p><strong>Helm:</strong> set <code className="mono-text text-foreground">mcp.enabled</code> to <code className="mono-text text-foreground">true</code> in the values file, then upgrade the release.</p>
          </div>
        </details>
      </div>
    </section>
  );
}
