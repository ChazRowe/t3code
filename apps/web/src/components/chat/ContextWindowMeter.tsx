import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  type AccountUsageSnapshot,
  formatResetCountdown,
  formatSubscriptionType,
  formatUsagePercent,
} from "~/lib/accountUsage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

// Colour the plan-usage bars by how close a window is to its limit, matching the
// gauge's blue→red intent and using amber as a midpoint warning.
function usageBarColor(utilization: number | null): string {
  if (utilization === null) {
    return "color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)";
  }
  if (utilization > 90) {
    return "var(--color-red-500)";
  }
  if (utilization > 75) {
    return "var(--color-amber-500)";
  }
  return "var(--color-blue-500)";
}

function AccountUsageBreakdown(props: { accountUsage: AccountUsageSnapshot }) {
  const { accountUsage } = props;
  const planLabel = formatSubscriptionType(accountUsage.subscriptionType);

  return (
    <div className="flex flex-col gap-2 border-border/60 border-t pt-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Usage limits</div>
        {planLabel ? <div className="text-[11px] text-muted-foreground/70">{planLabel}</div> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        {accountUsage.windows.map((window) => {
          const percent = formatUsagePercent(window.utilization);
          const reset = formatResetCountdown(window.resetsAt);
          const barWidth = Math.max(0, Math.min(100, window.utilization ?? 0));
          return (
            <div key={window.key} className="flex items-center gap-2">
              <div className="flex w-20 shrink-0 flex-col leading-tight">
                <span className="truncate text-[11px] text-muted-foreground/80">
                  {window.label}
                  {window.sublabel ? (
                    <span className="ml-1 text-muted-foreground/45">{window.sublabel}</span>
                  ) : null}
                </span>
                {reset ? (
                  <span className="truncate text-[10px] text-muted-foreground/50">{reset}</span>
                ) : null}
              </div>
              <div
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(barWidth)}
                aria-label={`${window.label} usage`}
              >
                <div
                  className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                  style={{
                    width: `${barWidth}%`,
                    backgroundColor: usageBarColor(window.utilization),
                  }}
                />
              </div>
              <span className="w-9 text-right text-[11px] text-muted-foreground/80 tabular-nums">
                {percent ?? "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  accountUsage?: AccountUsageSnapshot | null;
  providerDisplayName?: string | null;
}) {
  const { usage, accountUsage, providerDisplayName } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded ? "var(--color-red-500)" : "var(--color-blue-500)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-4 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-[11px] tabular-nums text-muted-foreground/70">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-[11px] tabular-nums text-muted-foreground/70">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-muted-foreground/60">Total processed</span>
              <span className="font-medium tabular-nums text-muted-foreground/80">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
              {providerDisplayName ?? "It"} automatically compacts its context when needed.
            </div>
          ) : null}
          {accountUsage && accountUsage.windows.length > 0 ? (
            <AccountUsageBreakdown accountUsage={accountUsage} />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
