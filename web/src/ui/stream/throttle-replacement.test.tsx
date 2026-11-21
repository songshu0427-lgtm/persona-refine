// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useThrottledText } from "./throttle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("never renders the prior live message while a reused Markdown slot receives a replacement", async () => {
  vi.useFakeTimers();
  const rendered: string[] = [];
  const host = document.createElement("div"), root = createRoot(host);
  function Probe({ text }: { text: string }) {
    const shown = useThrottledText(text, true);
    rendered.push(shown);
    return <div>{shown}</div>;
  }
  try {
    await act(async () => root.render(<Probe text="The previous reply" />));
    rendered.length = 0;
    await act(async () => root.render(<Probe text="The current reply" />));
    expect(rendered.every((s) => s === "The current reply")).toBe(true);
    expect(host.textContent).toBe("The current reply");
    rendered.length = 0;
    await act(async () => root.render(<Probe text="" />));
    expect(rendered.every((s) => s === "")).toBe(true);
    await act(async () => vi.advanceTimersByTime(500));
    expect(host.textContent).toBe("");
  } finally { act(() => root.unmount()); vi.useRealTimers(); }
});
