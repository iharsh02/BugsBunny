# Trigger.dev `chat.agent` drops tool results on AI SDK 7

With AI SDK 7, a `chat.agent` whose `prepareStep` returns `messages` stops sending new tool results to the model after the first one. From step 3 on, the model only sees the first tool call and its result, so it keeps repeating the same tool call until `stopWhen` ends the turn.

- **Affects:** `@trigger.dev/sdk` 4.7.5 – 4.8.1 with `ai` 7.x. The code is unchanged on `main` as of `fc33769a` (2026-10-26).
- **Works correctly on:** `ai` 6.x.
- **Issue draft:** [ISSUE.md](ISSUE.md)

## Run

```bash
npm ci
node repro.mjs control   # without prepareStep
node repro.mjs           # with a no-op prepareStep
```

`repro.mjs` uses only public API (`mockChatAgent` from `@trigger.dev/sdk/ai/test`) and a scripted `MockLanguageModelV3`, so it needs no network or API keys. The mock model calls a `lookup` tool 3 times, then answers. It logs the tool results in every prompt it receives.

### Expected (`control`)

```
model call 1 sees: []
model call 2 sees: [ 'result-1' ]
model call 3 sees: [ 'result-1', 'result-2' ]
model call 4 sees: [ 'result-1', 'result-2', 'result-3' ]
```

### Actual (with `prepareStep: ({ messages }) => ({ messages })`)

```
model call 1 sees: []
model call 2 sees: [ 'result-1' ]
model call 3 sees: [ 'result-1' ]      <- result-2 missing
model call 4 sees: [ 'result-1' ]      <- result-2 and result-3 missing
```

To compare with AI SDK 6, run `npm i ai@6.0.315`: both runs then match. Run `npm i ai@7.0.153` to switch back.

## With a real model

`real-agent.mjs` runs the same agent with a real model through the Vercel AI Gateway. Its `getCode` tool returns a random code and takes the previous code as input, so each call shows what the model thinks the last code was.

```bash
echo "AI_GATEWAY_API_KEY=your-key" > .env
MODEL=minimax/minimax-m3.1-flash GAP_MS=0 node --env-file=.env real-agent.mjs control
MODEL=minimax/minimax-m3.1-flash GAP_MS=0 node --env-file=.env real-agent.mjs
```

- `MODEL` sets the model. The default is the free `nvidia/nemotron-3.5-lightning-free`.
- `GAP_MS` sets the pause between model calls. It defaults to 13000 to stay under the free tier's 5 requests per minute; set it to `0` for paid models.

Without `prepareStep`, the model chains the 3 codes and answers correctly. With `prepareStep`, it keeps passing the first code as `previous` and calls `getCode` until it hits the 8-step cap:

```
model call 2 sees: [ 'CP' ]
  getCode -> L2        (previous: "CP")
model call 3 sees: [ 'CP' ]
  getCode -> KP        (previous: "CP")
...
getCode calls: 8 (asked for 3), no answer
```

## Conditions

All three must hold:

1. `ai` 7.x
2. `prepareStep` returns `messages`. Even a no-op one counts.
3. At least 3 tool steps in one turn. Step 2 is always correct.

## Cause

`chat.agent` wraps `prepareStep` in `retainStepMessages` ([`packages/trigger-sdk/src/v3/steeringContext.ts`](https://github.com/triggerdotdev/trigger.dev/blob/main/packages/trigger-sdk/src/v3/steeringContext.ts#L37-L41)):

```ts
const responses = input.steps.at(-1)?.response.messages ?? [];
const messages = retained ? [...retained, ...responses.slice(responseCount)] : input.messages;
```

In AI SDK 5 and 6, `step.response.messages` collects every step so far, so slicing off the ones already seen leaves only the new ones. AI SDK 7 holds only the current step there. Its migration guide calls this out in "Step Response Messages Are No Longer Accumulated". Every tool step has 2 messages, so `responseCount` stays at 2, and `responses.slice(2)` is empty from step 3 on.

## Fix

```diff
-const responses = input.steps.at(-1)?.response.messages ?? [];
+const responses = input.responseMessages ?? input.steps.at(-1)?.response.messages ?? [];
```

AI SDK 7 passes the full history to `prepareStep` as `responseMessages`. AI SDK 5 and 6 don't, so they fall back to the old code. The repro passes with this change on both `ai@6.0.315` and `ai@7.0.153`.

Dropping the slice (`[...retained, ...responses]`) fixes AI SDK 7 but duplicates tool results on AI SDK 6.

## Files

| File | Purpose |
| --- | --- |
| `repro.mjs` | The test above: mock model, no keys or network needed |
| `real-agent.mjs` | The same test with a real model via the AI Gateway |
| `ISSUE.md` | Issue text for `triggerdotdev/trigger.dev`, following their bug-report template |
