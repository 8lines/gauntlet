import type { Problem } from "@8lines/gauntlet-protocol";
import { CircleX } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { describeProblem } from "../../copy.ts";

/** `correlationId` is `run.problem.correlationId`, the value printed under a run problem. */
export function ProblemAlert({ problem, title, correlationId }: { problem: Problem; title?: string; correlationId?: string }) {
  const described = describeProblem(problem);
  return (
    <Alert className="border-err [&>svg]:text-err" role="alert">
      <CircleX className="text-err" />
      <AlertTitle>{title ?? described.title}</AlertTitle>
      <AlertDescription>
        <p>{title === undefined ? described.advice : `${described.title}. ${described.advice}`}</p>
        {correlationId !== undefined && <p className="font-mono text-xs/4">Correlation ID {correlationId}</p>}
      </AlertDescription>
    </Alert>
  );
}
