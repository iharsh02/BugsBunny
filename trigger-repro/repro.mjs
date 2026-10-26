// Must be imported before chat.agent() is defined.
import { mockChatAgent } from "@trigger.dev/sdk/ai/test";
import { chat } from "@trigger.dev/sdk/ai";
import { isStepCount, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

// `node repro.mjs control` runs without prepareStep.
const usePrepareStep = process.argv[2] !== "control";

const usage = {
  inputTokens: { total: 1, noCache: 1 },
  outputTokens: { total: 1, text: 1 },
};

// Fake model: calls `lookup` on calls 1-3, answers with text on call 4.
// Prints which tool results arrived in each prompt it receives.
let call = 0;
const model = new MockLanguageModelV3({
  doStream: async ({ prompt }) => {
    call++;
    const results = prompt
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .map((p) => p.output.value);
    console.log(`model call ${call} sees:`, results);

    const chunks =
      call <= 3
        ? [
            { type: "tool-call", toolCallId: `c${call}`, toolName: "lookup", input: JSON.stringify({ n: call }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
          ]
        : [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ];
    return { stream: simulateReadableStream({ chunks }) };
  },
});

const lookup = tool({
  inputSchema: z.object({ n: z.number() }),
  execute: async ({ n }) => `result-${n}`,
});

const agent = chat.agent({
  id: "repro",
  run: async ({ messages, signal, streamText }) =>
    streamText({
      model,
      messages,
      tools: { lookup },
      stopWhen: isStepCount(8),
      abortSignal: signal,
      ...(usePrepareStep && { prepareStep: ({ messages }) => ({ messages }) }),
    }),
});

const harness = mockChatAgent(agent, { chatId: "c1" });
await harness.sendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "go" }] });
await harness.close();
