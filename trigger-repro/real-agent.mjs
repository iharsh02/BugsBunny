// Same bug as repro.mjs, but with a real model instead of a scripted one.
// Uses a free model on the Vercel AI Gateway. Needs AI_GATEWAY_API_KEY.
// MODEL overrides the default model (any gateway id with tool use).
//
//   node real-agent.mjs control   # no prepareStep
//   node real-agent.mjs           # no-op prepareStep
//
// Must be imported before chat.agent() is defined.
import { mockChatAgent } from "@trigger.dev/sdk/ai/test";
import { chat } from "@trigger.dev/sdk/ai";
import { gateway, isStepCount, tool, wrapLanguageModel } from "ai";
import { z } from "zod";
import dotenv from "dotenv";
dotenv.config();

const usePrepareStep = process.argv[2] !== "control";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Set AI_GATEWAY_API_KEY.");
  process.exit(2);
}
const modelId = process.env.MODEL ?? "nvidia/nemotron-3.5-lightning-free";
// Free gateway models allow 5 requests per minute, so space calls out.
// Set GAP_MS=0 for a paid model.
const gapMs = Number(process.env.GAP_MS ?? 13_000);

// Log the tool results in every prompt the model actually receives.
let call = 0;
const model = wrapLanguageModel({
  model: gateway(modelId),
  middleware: {
    transformParams: async ({ params }) => {
      if (call > 0) await new Promise((r) => setTimeout(r, gapMs));
      call++;
      const results = params.prompt
        .filter((m) => m.role === "tool")
        .flatMap((m) => m.content)
        .map((p) => String(p.output.value).slice(0, 40));
      console.log(`model call ${call} sees:`, results);
      return params;
    },
  },
});

// Each call needs the previous code, so the model has to call it one step at
// a time and must read every result to finish the task.
const issued = [];
const getCode = tool({
  description: "Returns a new code. Pass the code from your previous call, or an empty string the first time.",
  inputSchema: z.object({ previous: z.string().default("") }),
  execute: async () => {
    const code = Math.random().toString(36).slice(2, 4).toUpperCase();
    issued.push(code);
    console.log(`  getCode -> ${code}`);
    return code;
  },
});

let answer = "";
const agent = chat.agent({
  id: "real-agent",
  run: async ({ messages, signal, streamText }) =>
    streamText({
      model,
      messages,
      tools: { getCode },
      stopWhen: isStepCount(8), // caps cost if the model loops
      abortSignal: signal,
      onStepFinish: ({ content, finishReason }) => {
        const parts = content
          .filter((p) => p.type === "tool-call" || p.type === "tool-error" || p.type === "text")
          .map((p) => (p.type === "text" ? `text ${JSON.stringify(p.text.slice(0, 60))}` : `${p.type} ${JSON.stringify(p.input)}`));
        console.log(`  step finished (${finishReason}):`, parts.join(", ") || "(nothing)");
      },
      onFinish: ({ text }) => {
        answer = text;
      },
      ...(usePrepareStep && { prepareStep: ({ messages }) => ({ messages }) }),
    }),
});

console.log(`${usePrepareStep ? "--- with prepareStep" : "--- control (no prepareStep)"} (${modelId})`);
const harness = mockChatAgent(agent, { chatId: "c1" });
await harness.sendMessage({
  id: "u1",
  role: "user",
  parts: [
    {
      type: "text",
      text: "Call getCode exactly 3 times, one call at a time. Then reply with only the 3 codes joined by dashes.",
    },
  ],
});
await harness.close();

const expected = issued.slice(0, 3).join("-");
console.log(`\ngetCode calls: ${issued.length} (asked for 3)`);
console.log(`expected answer: ${expected}`);
console.log(`model answered:  ${answer.trim() || "(no text)"}`);
console.log(issued.length === 3 && answer.includes(expected) ? "OK" : "WRONG: the model lost track of its tool results");
