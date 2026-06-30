import { useMemo } from "react";
import { RouterProvider } from "@tanstack/react-router";

import { createVsCodeShellRouter } from "./router";

import "../index.css";

export function VsCodeChatShell() {
  const router = useMemo(() => createVsCodeShellRouter(), []);
  return <RouterProvider router={router} />;
}
