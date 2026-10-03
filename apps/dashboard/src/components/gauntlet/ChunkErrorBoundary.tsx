import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleX } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** The boundary clears its error when this changes, so navigating elsewhere recovers. */
  resetKey?: string;
}

/**
 * Catches a failed dynamic import (flaky network, or a deploy that replaced the hashed chunks)
 * so one lazy screen cannot blank the whole dashboard or widget panel.
 */
export class ChunkErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Failed to load a screen", error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-8 sm:py-8">
        <Alert className="border-err [&>svg]:text-err" role="alert">
          <CircleX className="text-err" />
          <AlertTitle className="line-clamp-none">Could not load this screen</AlertTitle>
          <AlertDescription>
            <p>Check your connection, then try again.</p>
            <Button variant="outline" className="mt-2" onClick={() => globalThis.location.reload()}>Try again</Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
}
