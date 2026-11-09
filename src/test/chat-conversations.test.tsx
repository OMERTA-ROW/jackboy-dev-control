import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  navigate: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  search: vi.fn(),
  hub: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => mocks.navigate,
  useRouteContext: () => ({ user: { id: "owner" }, role: "owner" }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/chat-threads.functions", () => ({
  getChatThread: mocks.get,
  saveChatThread: mocks.save,
  listChatThreads: mocks.list,
  deleteChatThread: mocks.remove,
  renameChatThread: mocks.rename,
  searchChatHistory: mocks.search,
  getChatContextBrief: vi.fn(),
}));
vi.mock("@/lib/project-hub.functions", () => ({ getProjectHub: mocks.hub }));
vi.mock("@/lib/passport.functions", () => ({
  getVoiceChatStatus: async () => ({ voiceAvailable: false }),
  synthesizeJackboy: vi.fn(),
}));
vi.mock("@/components/CodeTasks", () => ({
  useCodeTasks: () => ({ cards: [], busy: false, submit: mocks.submit, receive: vi.fn() }),
  CodeTasks: () => null,
}));
vi.mock("@/components/ChatVoice", () => ({
  useChatVoice: () => ({ stopSpeaking: vi.fn(), speak: vi.fn() }),
  VoiceButtons: () => null,
}));
vi.mock("@/components/LiveVoiceCall", () => ({
  useLiveCall: () => ({ live: false, call: {} }),
  LiveCallBar: () => null,
  StartVoiceButton: () => null,
}));
vi.mock("@/components/chat/ChatAttachments", () => ({
  usePendingAttachments: () => ({ busy: true, hasReady: false }),
  AttachButton: () => null,
  PendingChips: () => null,
  MessageAttachments: () => null,
}));
vi.mock("@/components/chat/ChatContextSheet", () => ({
  ChatContextSheet: () => null,
  ContextNotesCard: () => null,
}));
vi.mock("@/components/chat/ChatStatusLine", () => ({ ChatStatusLine: () => null }));
vi.mock("@/components/chat/OmniToolResult", () => ({
  OMNI_TOOLS: new Set<string>(),
  OmniToolResult: () => null,
  TestOmniLinkButton: () => null,
}));
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ChatMessageActions", () => ({ ChatMessageActions: () => null }));
vi.mock("@ai-sdk/react", async () => {
  const React = await import("react");
  return {
    useChat: () => {
      const [messages, setMessages] = React.useState([]);
      return { messages, setMessages, status: "ready", stop: vi.fn(), sendMessage: vi.fn() };
    },
  };
});
import { ChatPage } from "@/components/chat/ChatPage";
import { ChatHistorySheet } from "@/components/chat/ChatHistorySheet";
import { Route as IndexRoute } from "@/routes/_authenticated/chat.index";

const id = "11111111-1111-4111-8111-111111111111";
const thread = {
  id,
  mode: "code" as const,
  title: "Saved title",
  context_key: "jackboy",
  updated_at: new Date().toISOString(),
};
beforeEach(() => {
  vi.clearAllMocks();
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
      clear: () => values.clear(),
    };
  };
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("jackboy.chat.view", "code");
  mocks.get.mockResolvedValue({ thread, messages: [] });
  mocks.list.mockResolvedValue([thread]);
  mocks.save.mockResolvedValue({ saved: 1 });
  mocks.submit.mockResolvedValue(true);
  mocks.hub.mockResolvedValue({
    projects: [{ id: "hercules", name: "Hercules Driver OS", github_repo: "owner/hercules" }],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps CODE Send enabled despite chat-only upload state and never defaults to Hercules", async () => {
  render(<ChatPage threadId={id} />);
  const input = await screen.findByRole("textbox", { name: "Describe the code change" });
  await waitFor(() => expect(screen.queryByText("Opening conversation…")).toBeNull());
  fireEvent.change(input, { target: { value: "Fix the footer" } });
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByText("Pick a project first.")).toBeInTheDocument();
  const picker = screen.getByLabelText("Project");
  expect(picker).toHaveValue("");
  expect(screen.getByRole("option", { name: "Hercules Driver OS" })).toBeInTheDocument();
  expect(mocks.submit).not.toHaveBeenCalled();
  fireEvent.change(picker, { target: { value: "Hercules Driver OS" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.submit).toHaveBeenCalledWith("CODE Hercules Driver OS: Fix the footer"),
  );
});

it("retains the draft and shows a blocked CODE error on Enter; Shift+Enter does not send", async () => {
  mocks.submit.mockRejectedValue(new Error("Emergency Stop is engaged"));
  render(<ChatPage threadId={id} />);
  const input = await screen.findByRole("textbox", { name: "Describe the code change" });
  await waitFor(() => expect(screen.queryByText("Opening conversation…")).toBeNull());
  fireEvent.change(input, { target: { value: "CODE Hercules Driver OS: fix footer" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(mocks.submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveTextContent("Emergency Stop is engaged");
  expect(input).toHaveValue("CODE Hercules Driver OS: fix footer");
});

it("autosaves submitted CODE messages and remembers the opened conversation", async () => {
  render(<ChatPage threadId={id} />);
  const input = await screen.findByRole("textbox", { name: "Describe the code change" });
  await waitFor(() => expect(screen.queryByText("Opening conversation…")).toBeNull());
  fireEvent.change(input, { target: { value: "CODE Hercules Driver OS: fix footer" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.save.mock.calls[0]?.[0].data.title).toBe("Saved title");
  expect(localStorage.getItem("jackboy.chat.last.owner")).toBe(id);
  expect(screen.getByRole("combobox", { name: "Saved conversations" })).toHaveValue(id);
  expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
});

it("renames via explicit save, searches history, and requires delete confirmation", async () => {
  const remove = vi.fn();
  const rename = vi.fn().mockResolvedValue(true);
  mocks.search.mockResolvedValue([]);
  render(
    <ChatHistorySheet
      open
      onOpenChange={vi.fn()}
      mode="code"
      threads={[thread]}
      loadError={null}
      activeId={id}
      onOpen={vi.fn()}
      onDelete={remove}
      onRename={rename}
      localCount={0}
      onImport={vi.fn()}
      importing={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Rename conversation Saved title" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Conversation title" }), {
    target: { value: "Footer repairs" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rename).toHaveBeenCalledWith(id, "Footer repairs"));
  fireEvent.click(screen.getByRole("button", { name: "Delete conversation Saved title" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete conversation Saved title" }));
  fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
  expect(remove).toHaveBeenCalledWith(id);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "footer" } });
  await waitFor(() => expect(mocks.search).toHaveBeenCalledWith({ data: { q: "footer" } }));
});

it("restores the last opened account conversation rather than the most recently updated one", async () => {
  const otherId = "22222222-2222-4222-8222-222222222222";
  localStorage.setItem("jackboy.chat.last.owner", id);
  mocks.list.mockResolvedValue([{ ...thread, id: otherId }, thread]);
  const Index = IndexRoute.options.component!;
  render(<Index />);
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/chat/$threadId",
      params: { threadId: id },
      replace: true,
    }),
  );
});
