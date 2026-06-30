import { CONTINUE_MESSAGE, DEFAULT_UNIFIED_SETTINGS, WRAP_SENTINEL } from "@t3tools/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { DraftInput } from "../ui/draft-input";
import { DraftTextarea } from "../ui/draft-textarea";
import { Switch } from "../ui/switch";
import { preambleMissingEffectiveSentinel } from "./loopingSettings.ts";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const DEFAULTS = DEFAULT_UNIFIED_SETTINGS.unattendedRun;

export function LoopingSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const cfg = settings.unattendedRun;
  const effectiveSentinel = cfg.sentinel || WRAP_SENTINEL;
  const showPreambleWarning = preambleMissingEffectiveSentinel(cfg.preamble, effectiveSentinel);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Looping">
        <SettingsRow
          title="Preamble"
          description="Opens iteration 1 and sets the unattended contract. Leave empty to use the built-in, model-aware preamble. Sent verbatim — no substitutions."
          resetAction={
            cfg.preamble !== DEFAULTS.preamble ? (
              <SettingResetButton
                label="preamble"
                onClick={() =>
                  updateSettings({ unattendedRun: { ...cfg, preamble: DEFAULTS.preamble } })
                }
              />
            ) : null
          }
          control={
            <DraftTextarea
              className="w-full sm:w-96"
              value={cfg.preamble}
              onCommit={(next) => updateSettings({ unattendedRun: { ...cfg, preamble: next } })}
              placeholder="Leave empty to use the built-in, model-aware preamble."
              spellCheck={false}
              aria-label="Unattended-run preamble"
            />
          }
        >
          {showPreambleWarning ? (
            <p className="pt-2 pb-3.5 text-xs text-amber-600 dark:text-amber-500">
              Your custom preamble does not mention the sentinel{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{effectiveSentinel}</code>.
              The run can only advance when the agent emits it, so be sure to instruct the agent to
              print it on its own line.
            </p>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title="Continue message"
          description="Sent for iterations 2..N after the context is cleared. Leave empty to use the built-in default. Sent verbatim — no substitutions."
          resetAction={
            cfg.continueMessage !== DEFAULTS.continueMessage ? (
              <SettingResetButton
                label="continue message"
                onClick={() =>
                  updateSettings({
                    unattendedRun: { ...cfg, continueMessage: DEFAULTS.continueMessage },
                  })
                }
              />
            ) : null
          }
          control={
            <DraftTextarea
              className="w-full sm:w-96"
              value={cfg.continueMessage}
              onCommit={(next) =>
                updateSettings({ unattendedRun: { ...cfg, continueMessage: next } })
              }
              placeholder={CONTINUE_MESSAGE}
              spellCheck={false}
              aria-label="Unattended-run continue message"
            />
          }
        />

        <SettingsRow
          title="Sentinel"
          description="The line the reactor watches for to advance the run. Leave empty to use the built-in default."
          resetAction={
            cfg.sentinel !== DEFAULTS.sentinel ? (
              <SettingResetButton
                label="sentinel"
                onClick={() =>
                  updateSettings({ unattendedRun: { ...cfg, sentinel: DEFAULTS.sentinel } })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={cfg.sentinel}
              onCommit={(next) => updateSettings({ unattendedRun: { ...cfg, sentinel: next } })}
              placeholder={WRAP_SENTINEL}
              spellCheck={false}
              aria-label="Unattended-run sentinel"
            />
          }
        />

        <SettingsRow
          title="Append last agent message"
          description="Append the previous iteration's final assistant message to the continue message so the fresh context carries it forward."
          resetAction={
            cfg.appendLastAgentMessage !== DEFAULTS.appendLastAgentMessage ? (
              <SettingResetButton
                label="append last agent message"
                onClick={() =>
                  updateSettings({
                    unattendedRun: {
                      ...cfg,
                      appendLastAgentMessage: DEFAULTS.appendLastAgentMessage,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={cfg.appendLastAgentMessage}
              onCheckedChange={(checked) =>
                updateSettings({
                  unattendedRun: { ...cfg, appendLastAgentMessage: Boolean(checked) },
                })
              }
              aria-label="Append last agent message to the continue message"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
