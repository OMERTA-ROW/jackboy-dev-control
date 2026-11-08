import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ChatActivity, activityDetails, VerifiedActivity } from "@/components/chat/ChatActivity";

afterEach(cleanup);

it("shows expandable real tool activity and updates from running to actual file results", () => {
  const { rerender } = render(
    <ChatActivity
      parts={[
        {
          type: "dynamic-tool",
          toolName: "writeFile",
          toolCallId: "edit",
          state: "input-available",
          input: { path: "src/footer.tsx", content: "private source" },
        },
      ]}
    />,
  );
  expect(screen.getByText(/Writing and editing code · In progress/)).toBeInTheDocument();
  const details = screen.getByText(/Writing and editing code/).closest("details")!;
  expect(details).not.toHaveAttribute("open");
  fireEvent.click(details.querySelector("summary")!);
  expect(screen.getByText("File: src/footer.tsx")).toBeInTheDocument();
  expect(screen.queryByText("private source")).toBeNull();
  rerender(
    <ChatActivity
      parts={[
        {
          type: "dynamic-tool",
          toolName: "writeFile",
          toolCallId: "edit",
          state: "output-available",
          input: { path: "src/footer.tsx" },
          output: { path: "src/footer.tsx", commit: "abc123", action: "updated" },
        },
      ]}
    />,
  );
  expect(screen.getByText(/Result received/)).toBeInTheDocument();
  expect(screen.getByText("commit: abc123")).toBeInTheDocument();
});

it("renders reported test results, blocks and errors without claiming deployment", () => {
  render(
    <ChatActivity
      parts={[
        {
          type: "dynamic-tool",
          toolName: "checkStatus",
          toolCallId: "tests",
          state: "output-available",
          input: {},
          output: {
            runs: [{ name: "typescript", status: "completed", conclusion: "failure" }],
            blocked: true,
            reason: "Owner approval required",
          },
        },
      ]}
    />,
  );
  expect(screen.getByText("typescript · completed · failure")).toBeInTheDocument();
  expect(screen.getByText("Blocked: Owner approval required")).toBeInTheDocument();
  expect(screen.queryByText(/Deploying/)).toBeNull();
});

it("does not display reasoning, tokens, source contents or arbitrary output fields", () => {
  const details = activityDetails(
    { path: "src/app.ts", token: "hidden", prompt: "private reasoning" },
    {
      content: "source contents",
      reasoning: "private reasoning",
      token: "hidden",
      error: "secret=opaque-value Bearer opaque-credential",
    },
  );
  expect(details.join(" ")).not.toContain("opaque-value");
  expect(details.join(" ")).not.toContain("opaque-credential");
  expect(details.join(" ")).not.toContain("private reasoning");
  expect(details.join(" ")).not.toContain("source contents");
});

it("shows no fabricated activity from text or private reasoning parts", () => {
  const { container } = render(
    <ChatActivity
      parts={[
        { type: "text", text: "I deployed it" },
        { type: "reasoning", text: "thinking" },
      ]}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});

it("shows real GitHub job status in expandable CODE activity", () => {
  render(
    <VerifiedActivity
      label="validate"
      running={false}
      failed
      details={["Status: completed", "Conclusion: failure"]}
    />,
  );
  expect(screen.getByText(/validate · Blocked or failed/)).toBeInTheDocument();
  expect(screen.getByText("Conclusion: failure")).toBeInTheDocument();
});
