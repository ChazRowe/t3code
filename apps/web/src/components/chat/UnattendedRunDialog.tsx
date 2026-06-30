"use client";

import { UNATTENDED_RUN_MAX_ITERATIONS } from "@t3tools/contracts";
import * as React from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";

interface UnattendedRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (totalIterations: number) => void;
}

export function UnattendedRunDialog({ open, onOpenChange, onConfirm }: UnattendedRunDialogProps) {
  const [count, setCount] = React.useState(5);

  React.useEffect(() => {
    if (open) setCount(5);
  }, [open]);

  const handleConfirm = () => {
    const clamped = Math.max(1, Math.min(UNATTENDED_RUN_MAX_ITERATIONS, count));
    onConfirm(clamped);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Start looping run</AlertDialogTitle>
          <AlertDialogDescription>
            T3 will run the agent repeatedly up to the number of iterations you choose. The agent
            must end each wrap with the sentinel token so T3 can clear context and continue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="px-6 pb-4">
          <NumberField
            value={count}
            min={1}
            max={UNATTENDED_RUN_MAX_ITERATIONS}
            onValueChange={(value) => {
              if (value !== null) setCount(value);
            }}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease iterations" />
              <NumberFieldInput aria-label="Number of iterations" />
              <NumberFieldIncrement aria-label="Increase iterations" />
            </NumberFieldGroup>
          </NumberField>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={handleConfirm}>Start run</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
