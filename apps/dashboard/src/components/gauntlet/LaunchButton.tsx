import { useEffect, useRef, useState } from "react";
import type { Problem } from "@8lines/gauntlet-protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { beginBrowserLaunch, type BrowserLaunchAttempt } from "../../run-actions.ts";
import { ProblemAlert } from "./ProblemAlert.tsx";

/** Opens a one-time browser session. The popup is opened inside the click so the browser does not block it. */
export function LaunchButton(
  { targetId, runId, artifactId, label = "Open" }: { targetId: string; runId: string; artifactId: string; label?: string },
) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const mounted = useRef(false);
  const generation = useRef(0);
  const activeAttempt = useRef<BrowserLaunchAttempt | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      activeAttempt.current?.cancel();
      activeAttempt.current = undefined;
    };
  }, []);

  const launch = () => {
    activeAttempt.current?.cancel();
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    setPending(true);
    setProblem(undefined);
    const attempt = beginBrowserLaunch(targetId, runId, artifactId);
    activeAttempt.current = attempt;
    void attempt.result.then((launchProblem) => {
      if (!mounted.current || generation.current !== requestGeneration) return;
      activeAttempt.current = undefined;
      setPending(false);
      setProblem(launchProblem);
    });
  };

  return (
    <div className={cn("space-y-2", problem !== undefined && "basis-full")}>
      <Button variant="outline" disabled={pending} onClick={launch}>
        {pending ? "Opening…" : label}
      </Button>
      {problem !== undefined && <ProblemAlert problem={problem} />}
    </div>
  );
}
