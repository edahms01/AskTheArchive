# AskTheArchive

A chat interface for the declassified Election Integrity document release: vulnerabilities in electronic voting and ballot-counting systems, China's acquisition and exploitation of American voter data, the Michigan voter-registration investigation, and noncitizens on state voter rolls.

Static `index.html` + a single Netlify Edge Function (`netlify/edge-functions/ask.js`), no build step, no framework — same pattern as this site's sibling project, AskFrankie.

The assistant answers strictly from retrieved passages in the source documents (a neutral document-analyst persona, not a political voice), and surfaces the source filename for each answer as a citation chip.

## How it works

- The frontend posts `{ query, history }` to `/.netlify/functions/ask`.
- The edge function calls LlamaCloud's pipeline chat endpoint (`POST /api/v1/pipelines/{pipeline_id}/chat`), which does retrieval + LLM generation server-side against the already-indexed document set (model: `CLAUDE_4_5_SONNET`, via LlamaCloud's own model integration — no separate Anthropic/OpenAI key needed here).
- That endpoint streams the [Vercel AI SDK "data stream protocol"](https://ai-sdk.dev) (`0:"text chunk"` for tokens, `8:[{"type":"sources","data":{"nodes":[...]}}]` for the retrieved-node metadata used as citations). The edge function parses that and re-emits a simpler NDJSON stream (`{type:"delta"|"citations"|"error"}`) that the frontend consumes.

## ⚠️ Deprecated endpoint

`POST /pipelines/{pipeline_id}/chat` is currently marked `deprecated` in LlamaCloud's OpenAPI spec, in favor of a newer session-based chat API (`POST /chat` to create a session, then `POST /chat/{session_id}/messages/stream`). It still works as of this writing and was chosen here because it takes the `pipeline_id` we already have directly, with no separate session/index-lookup step. If LlamaIndex sunsets it, migrate to the session API — that one wants `index_id` + `project_id`/`organization_id` instead of `pipeline_id`.

## Setup

Set `LLAMA_CLOUD_API_KEY` in Netlify's dashboard under Site settings → Environment variables. Never commit a real key — `.env.example` only holds the placeholder.

## Local dev

```
netlify dev
```

Requires the Netlify CLI and `LLAMA_CLOUD_API_KEY` set in your local `.env` (gitignored).
