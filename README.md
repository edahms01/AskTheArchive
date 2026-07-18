# AskTheArchive

A chat interface for the declassified Election Integrity document release: vulnerabilities in electronic voting and ballot-counting systems, China's acquisition and exploitation of American voter data, the Michigan voter-registration investigation, and noncitizens on state voter rolls.

Static `index.html` + a single Netlify Edge Function (`netlify/edge-functions/ask.js`), no build step, no framework — same pattern as this site's sibling project, AskFrankie.

The assistant answers strictly from retrieved passages in the source documents (a neutral document-analyst persona, not a political voice), and surfaces the source filename for each answer as a citation chip.

## How it works

- The frontend posts `{ query, history }` to `/.netlify/functions/ask`.
- The edge function calls LlamaCloud's pipeline chat endpoint (`POST /api/v1/pipelines/{pipeline_id}/chat`), which does retrieval + LLM generation server-side against the already-indexed document set (model: `CLAUDE_4_5_SONNET`, via LlamaCloud's own model integration — no separate Anthropic/OpenAI key needed here).
- That endpoint streams the [Vercel AI SDK "data stream protocol"](https://ai-sdk.dev) (`0:"text chunk"` for tokens, `8:[{"type":"sources","data":{"nodes":[...]}}]` for the retrieved-node metadata used as citations). The edge function parses that and re-emits a simpler NDJSON stream (`{type:"delta"|"citations"|"error"}`) that the frontend consumes.

## ⚠️ Deprecated endpoint (deliberately not migrated)

`POST /pipelines/{pipeline_id}/chat` is marked `deprecated` in LlamaCloud's OpenAPI spec, in favor of a newer session-based chat API (`POST /chat` to create a session, then `POST /chat/{session_id}/messages/stream`). We tried migrating and hit a dead end: the new API expects an `index_id` from a separate "Indexes"/agent-data product surface, and this pipeline's ID isn't recognized there — a live test returned `{"detail":"Export config <pipeline_id> not found in project."}` even though the dashboard displays the same UUID as both "Pipeline ID" and "Index ID". So the two chat APIs aren't interchangeable for this project as currently set up; migrating for real would mean finding or creating an actual index under that newer surface, not just swapping endpoints.

Staying on the deprecated endpoint is a deliberate choice, not an oversight. It still works. If LlamaIndex sunsets it, that's the point to revisit whether this project has (or needs) a proper index under the newer chat API.

## Setup

Set `LLAMA_CLOUD_API_KEY` in Netlify's dashboard under Site settings → Environment variables. Never commit a real key — `.env.example` only holds the placeholder.

## Local dev

```
netlify dev
```

Requires the Netlify CLI and `LLAMA_CLOUD_API_KEY` set in your local `.env` (gitignored).
