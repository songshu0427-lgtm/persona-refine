// @vitest-environment jsdom
// The outbox is already a startup dependency. This intent must use its narrow named entry,
// not materialize every outbox export (including test helpers) through a dynamic namespace.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/outbox", async (actual) => ({ ...await actual<typeof import("../../lib/outbox")>(), askPersona: vi.fn(async () => {}) }));
vi.mock("../../ui/atoms", async (actual) => ({ ...await actual<typeof import("../../ui/atoms")>(), toast: vi.fn() }));

import { askPersona } from "../../lib/outbox";
import { toast } from "../../ui/atoms";
import { t } from "../../i18n";
import { askAssistant } from "./ExtensionView";

beforeEach(() => {
  vi.mocked(askPersona).mockReset().mockResolvedValue(undefined);
  vi.mocked(toast).mockClear();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Fixture must not use network"); }));
});
const settle = async () => {
  await vi.dynamicImportSettled();
  // Cached imports still schedule the caller's .then/.catch after the module loader settles.
  for (let n = 0; n < 5; n++) await Promise.resolve();
};
afterEach(async () => { await settle(); vi.unstubAllGlobals(); });

it("dispatches once immediately through the existing outbox without a module-load wait", async () => {
  askAssistant("Fixture setup request");
  const immediate = vi.mocked(askPersona).mock.calls.length;
  await settle();
  expect(immediate).toBe(1);
  expect(askPersona).toHaveBeenCalledExactlyOnceWith("Fixture setup request");
  expect(toast).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps the existing recoverable error notice when the outbox rejects", async () => {
  vi.mocked(askPersona).mockRejectedValueOnce(new Error("Fixture refusal"));
  askAssistant("Fixture setup request");
  await settle();
  expect(toast).toHaveBeenCalledExactlyOnceWith(t("settings-extensionview.action_failed", { error: "Fixture refusal" }), "error");
  expect(askPersona).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not coalesce two intentional same-text handoffs", async () => {
  askAssistant("Same fixture text");
  askAssistant("Same fixture text");
  await settle();
  expect(askPersona).toHaveBeenCalledTimes(2);
  expect(vi.mocked(askPersona).mock.calls).toEqual([["Same fixture text"], ["Same fixture text"]]);
  expect(fetch).not.toHaveBeenCalled();
});
