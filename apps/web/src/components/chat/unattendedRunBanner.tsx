import type { UnattendedRunState } from "@t3tools/contracts";
import { PauseIcon, PlayIcon, SquareIcon, TimerIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function describeReason(reason: UnattendedRunState["pauseReason"]): string {
  if (reason === "no-sentinel") {
    return "Agent stopped without wrapping — it may be asking a question.";
  }
  if (reason === "error") {
    return "The run was paused because an error occurred.";
  }
  if (reason === "manual") {
    return "Paused by you.";
  }
  return "The run is paused.";
}

export function buildUnattendedRunBannerItem(input: {
  run: UnattendedRunState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}): ComposerBannerStackItem | null {
  const { run, onPause, onResume, onStop } = input;

  if (run.status === "completed" || run.status === "stopped") {
    return null;
  }

  const isRunning = run.status === "running";
  const title = `Unattended run · iteration ${run.currentIteration} of ${run.totalIterations} · ${run.status}`;

  return {
    id: "unattended-run",
    variant: isRunning ? "info" : "warning",
    icon: <TimerIcon />,
    title,
    description: isRunning ? undefined : describeReason(run.pauseReason),
    actions: (
      <>
        {isRunning ? (
          <Button size="xs" variant="outline" onClick={onPause}>
            <PauseIcon className="mr-1 size-3.5" />
            Pause
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={onResume}>
            <PlayIcon className="mr-1 size-3.5" />
            Resume
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={onStop}>
          <SquareIcon className="mr-1 size-3.5" />
          Stop
        </Button>
      </>
    ),
  };
}
