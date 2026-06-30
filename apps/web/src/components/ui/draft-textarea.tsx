"use client";

import { type ChangeEvent, useEffect, useRef, useState } from "react";

import { Textarea, type TextareaProps } from "./textarea";

export type DraftTextareaProps = Omit<TextareaProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Multiline `<Textarea>` that buffers keystrokes locally and invokes `onCommit`
 * only on blur. Unlike `DraftInput`, Enter inserts a newline (the field holds
 * multi-line prompts), so there is no commit-on-Enter. The draft resynchronizes
 * from the upstream `value` only while unfocused, so an external push (e.g. a
 * reset to default) does not clobber an in-progress edit.
 */
export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(value);
    }
  }, [value]);

  return (
    <Textarea
      {...rest}
      value={draft}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (draft !== value) {
          onCommit(draft);
        }
      }}
    />
  );
}
