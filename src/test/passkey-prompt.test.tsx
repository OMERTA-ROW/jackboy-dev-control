import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), reg: vi.fn(), supported: vi.fn(() => true) }));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: mocks.auth, startRegistration: mocks.reg, browserSupportsWebAuthn: mocks.supported, WebAuthnAbortService: { cancelCeremony: vi.fn() } }));
import { PasskeyPromptHost } from "@/components/PasskeyPromptHost";
import { requestPasskey, PASSKEY_CANCELLED } from "@/lib/passkey-prompt";

const OPTIONS = { challenge: "abc" };
beforeEach(() => { vi.resetAllMocks(); mocks.supported.mockReturnValue(true); Object.defineProperty(window, "isSecureContext", { value: true, configurable: true }); });
afterEach(cleanup);

function start(finish = vi.fn().mockResolvedValue({ grantId: "g1" })) {
  const prepare = vi.fn().mockResolvedValue({ kind: "auth", challengeId: "c1", options: OPTIONS });
  let p!: Promise<unknown>;
  act(() => { p = requestPasskey({ title: "Confirm with your passkey", description: "Turn the Kill Switch on", prepare, finish }); });
  return { p, prepare, finish };
}

it("fails clearly when no passkey window is mounted", async () => {
  await expect(requestPasskey({ title: "x", prepare: vi.fn(), finish: vi.fn() })).rejects.toThrow(/isn't ready/);
});

it("does not touch the device until the owner taps Use passkey, then verifies and reports success", async () => {
  render(<PasskeyPromptHost />);
  mocks.auth.mockResolvedValue({ id: "cred" });
  const { p, prepare, finish } = start();
  const button = await screen.findByRole("button", { name: /Use passkey/ });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(mocks.auth).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(mocks.auth).toHaveBeenCalledWith({ optionsJSON: OPTIONS }); // called synchronously inside the tap
  expect(await screen.findByText("Passkey confirmed.")).toBeInTheDocument();
  await expect(p).resolves.toEqual({ grantId: "g1" });
  expect(finish).toHaveBeenCalledWith("c1", { id: "cred" });
});

it("shows a cancelled device prompt as a failure and offers Try again with a new challenge", async () => {
  render(<PasskeyPromptHost />);
  mocks.auth.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
  const { p, prepare, finish } = start();
  fireEvent.click(await screen.findByRole("button", { name: /Use passkey/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled or timed out/);
  expect(finish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: /Use passkey/ });
  expect(prepare).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await expect(p).rejects.toThrow(PASSKEY_CANCELLED);
});

it("a server rejection is shown and never resolves a grant", async () => {
  render(<PasskeyPromptHost />);
  mocks.auth.mockResolvedValue({ id: "cred" });
  const { p } = start(vi.fn().mockRejectedValue(new Error("Passkey check failed.")));
  fireEvent.click(await screen.findByRole("button", { name: /Use passkey/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Passkey check failed.");
  fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
  await expect(p).rejects.toThrow("Passkey check failed.");
});

it("blocks with a clear reason when passkeys aren't supported, without asking the server", async () => {
  mocks.supported.mockReturnValue(false);
  render(<PasskeyPromptHost />);
  const { p, prepare } = start();
  expect(await screen.findByRole("alert")).toHaveTextContent(/doesn't support passkeys/);
  expect(prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
  await expect(p).rejects.toThrow(/doesn't support passkeys/);
});

it("only one passkey check can be open at a time", async () => {
  render(<PasskeyPromptHost />);
  const first = start();
  await screen.findByRole("button", { name: /Use passkey/ });
  await expect(requestPasskey({ title: "y", prepare: vi.fn(), finish: vi.fn() })).rejects.toThrow(/already open/);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await expect(first.p).rejects.toThrow(PASSKEY_CANCELLED);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
