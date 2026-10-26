# bug: chat.agent drops tool results from step 3 on when prepareStep returns messages (AI SDK 7)

<!-- Template: 🐞 Bug Report — https://github.com/triggerdotdev/trigger.dev/issues/new?template=bug_report.yml -->

## Provide environment information

```
  System:
    OS: Linux 7.2 CachyOS Linux
    CPU: (16) x64 AMD Ryzen 7 4800H with Radeon Graphics
    Memory: 2.75 GB / 15.04 GB
    Container: Yes
    Shell: 5.9.2 - /usr/bin/zsh
  Binaries:
    Node: 24.18.0 - /home/senpai/.local/share/nvm/v24.18.0/bin/node
    npm: 12.0.1 - /home/senpai/.local/share/nvm/v24.18.0/bin/npm
    pnpm: 11.13.1 - /home/senpai/.local/share/nvm/v24.18.0/bin/pnpm
    bun: 1.3.14 - /home/senpai/.bun/bin/bun
```

Packages: `@trigger.dev/sdk@4.8.1`, `ai@7.0.153`, `zod@4.6.7`.

## Describe the bug

With AI SDK 7, if a `chat.agent`'s `streamText` has a `prepareStep` that returns `messages`, the model stops receiving new tool results after the first one. From step 3 on, every prompt contains only the first tool call and its result. The model never sees its later results, so it repeats the same tool call until `stopWhen` ends the turn.

Even a no-op `prepareStep: ({ messages }) => ({ messages })` triggers it. In our production agent this showed up as the model running the same shell command dozens of times in one turn.

**Expected:** each step's prompt includes every earlier tool call and result, the same as without `prepareStep`.

**Cause:** `chat.agent` wraps `prepareStep` in `retainStepMessages` ([`packages/trigger-sdk/src/v3/steeringContext.ts`](https://github.com/triggerdotdev/trigger.dev/blob/main/packages/trigger-sdk/src/v3/steeringContext.ts#L37-L41)):

```ts
const responses = input.steps.at(-1)?.response.messages ?? [];
const messages = retained ? [...retained, ...responses.slice(responseCount)] : input.messages;
// ...
responseCount = responses.length;
```

That code was written for AI SDK 5/6, where `step.response.messages` holds every message so far, so slicing off the first `responseCount` leaves only the new ones. AI SDK 7 changed this (migration guide, "Step Response Messages Are No Longer Accumulated"): each step's `response.messages` holds only that step's messages. A tool step always yields 2 messages (tool call + tool result), so `responseCount` stays at 2, and from step 3 on `responses.slice(2)` is empty. Nothing new is added to `retained`, and the stale copy replaces the correct `input.messages`.

| Step | `responses` (AI SDK 7) | `responseCount` | Added to history |
|---|---|---|---|
| 2 | step 1's 2 messages | 0 | both ✓ |
| 3 | step 2's 2 messages | 2 | nothing ✗ |
| 4 | step 3's 2 messages | 2 | nothing ✗ |

All of these are needed to hit it:
1. `ai` 7.x. With `ai@6.0.315`, the same code works.
2. `prepareStep` returns `messages`. Without that, the wrapper passes `input.messages` through.
3. At least 3 tool steps in one turn. Step 2 is always correct.

## Reproduction repo

https://github.com/iharsh02/BugsBunny/tree/main/trigger-repro

## To reproduce

```bash
git clone https://github.com/iharsh02/BugsBunny.git
cd BugsBunny/trigger-repro
npm ci
node repro.mjs control   # no prepareStep
node repro.mjs           # no-op prepareStep
```

`repro.mjs` uses only public API and needs no network or API keys. It runs a `chat.agent` through `mockChatAgent` from `@trigger.dev/sdk/ai/test`, with a scripted `MockLanguageModelV3` that calls a `lookup` tool 3 times (its `execute` returns `result-N`) and then answers. Each model call logs the tool results in the `prompt` it actually received.

The core of it:

```js
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
```

Output:

```
$ node repro.mjs control
model call 1 sees: []
model call 2 sees: [ 'result-1' ]
model call 3 sees: [ 'result-1', 'result-2' ]
model call 4 sees: [ 'result-1', 'result-2', 'result-3' ]

$ node repro.mjs
model call 1 sees: []
model call 2 sees: [ 'result-1' ]
model call 3 sees: [ 'result-1' ]      <- result-2 missing
model call 4 sees: [ 'result-1' ]      <- result-2 and result-3 missing
```

With `npm i ai@6.0.315`, both runs match.

## Suggested fix

AI SDK 7 passes the accumulated history to `prepareStep` as `responseMessages`. AI SDK 5/6 don't have that field, so falling back keeps their behaviour unchanged:

```diff
 type StepInput = {
   messages: ModelMessage[];
   steps: Array<{ response: { messages: ModelMessage[] } }>;
+  /** AI SDK 7+: response messages accumulated across all steps so far. */
+  responseMessages?: ModelMessage[];
 };

-    const responses = input.steps.at(-1)?.response.messages ?? [];
+    const responses = input.responseMessages ?? input.steps.at(-1)?.response.messages ?? [];
```

I applied this change to the built `dist` of 4.8.1 and the repro passes on both `ai@6.0.315` and `ai@7.0.153`.

The obvious alternative, dropping the slice (`[...retained, ...responses]`), fixes AI SDK 7 but duplicates tool results on AI SDK 6: step 3 sees `['result-1', 'result-1', 'result-2']`. The SDK's peer range still includes `ai` 5 and 6, so that version isn't safe.

## Additional information

**With a real model.** `real-agent.mjs` in the repro repo runs the same `chat.agent` with a real model (`minimax/minimax-m3.1-flash` via the AI Gateway). Its `getCode` tool returns a random code and takes the previous code as input, so the call's argument shows what the model thinks the last code was. The prompt is "Call getCode exactly 3 times, one call at a time. Then reply with only the 3 codes joined by dashes."

Without `prepareStep`:

```
model call 1 sees: []
  getCode -> 5Y        (previous: "")
model call 2 sees: [ '5Y' ]
  getCode -> ZG        (previous: "5Y")
model call 3 sees: [ '5Y', 'ZG' ]
  getCode -> PE        (previous: "ZG")
model call 4 sees: [ '5Y', 'ZG', 'PE' ]
  answer: "5Y-ZG-PE"   ✓
```

With `prepareStep: ({ messages }) => ({ messages })`:

```
model call 1 sees: []
  getCode -> CP        (previous: "")
model call 2 sees: [ 'CP' ]
  getCode -> L2        (previous: "CP")
model call 3 sees: [ 'CP' ]
  getCode -> KP        (previous: "CP")
model call 4 sees: [ 'CP' ]
  getCode -> 0B        (previous: "CP")
...
model call 8 sees: [ 'CP' ]
  getCode -> 8I        (previous: "CP")

getCode calls: 8 (asked for 3), no answer — stopped by isStepCount(8)
```

The model keeps passing `previous: "CP"` because it never sees `L2`, `KP` and the later codes. That's the same loop we hit in production.

**Affected versions.** I reproduced this on `@trigger.dev/sdk` 4.8.1 with `ai` 7.0.153. We first hit it on 4.7.5 and also saw it on 4.7.7 and with `ai` 7.0.146. The code is unchanged on `main` as of fc33769a (2026-10-26).

**Workaround until a fix ships.** Patch `dist/esm/v3/steeringContext.js` and `dist/commonjs/v3/steeringContext.js` with the one-line change from "Suggested fix", or don't return `messages` from `prepareStep`.
