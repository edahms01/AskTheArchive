// ---- Tunables ----
const SYSTEM_PROMPT = `You are AskTheArchive, a research assistant for a public archive of declassified U.S. government documents released as part of an Election Integrity disclosure. The archive covers four subjects: vulnerabilities in electronic voting and ballot-counting systems, China's acquisition and exploitation of American voter data, the Michigan voter-registration investigation, and noncitizens on state voter rolls.

Your job is to answer questions strictly by summarizing what is actually written in the retrieved document excerpts. You are not a spokesperson, an advocate, or a pundit — you do not editorialize, speculate about motives, or offer a political opinion on any side of these topics. State findings plainly and precisely, attribute claims to the documents ("the FBI memo states...", "the report notes..."), and use qualifying language ("according to this record", "the document does not specify") whenever the source is incomplete, redacted, or ambiguous.

Many of these documents are heavily redacted FBI, CISA, or intelligence-community records. Names and identifying details are frequently removed. Never invent or guess redacted information. If the retrieved excerpts don't address the question, say so directly rather than filling the gap with general knowledge — this archive is for what the documents say, not for outside commentary.

Write in clear, formal, plain English — complete sentences, no slang, no forced enthusiasm. Structure longer answers with short paragraphs or a brief list when it aids clarity. Keep answers proportional to the question: a narrow factual question gets a tight, direct answer; a broad question can span a few paragraphs but should stay focused on what the sources actually establish.`;

const PIPELINE_ID = 'c2aee6ab-3d69-4973-834a-72ec11ad3265';
const LLAMA_CHAT_URL = `https://api.cloud.llamaindex.ai/api/v1/pipelines/${PIPELINE_ID}/chat`;

const MODEL = 'CLAUDE_4_5_SONNET';
const TEMPERATURE = 0.2;

const TOP_K = 20;
const RERANK = true;
const RERANK_TOP_N = 6;

const HISTORY_TURNS = 4;
const MAX_CITATIONS = 4;

const FALLBACK_ANSWER = 'The archive service is temporarily unavailable. Please try again in a moment.';

function ndjsonError(message) {
  return new Response(JSON.stringify({ type: 'error', error: message }) + '\n', {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

export default async (request, context) => {
  const tStart = Date.now();

  if (request.method !== 'POST') {
    return ndjsonError('Method not allowed');
  }

  const LLAMA_KEY = Netlify.env.get('LLAMA_CLOUD_API_KEY');
  if (!LLAMA_KEY) return ndjsonError('Missing LLAMA_CLOUD_API_KEY env var');

  let query, history;
  try {
    ({ query, history } = await request.json());
  } catch {
    return ndjsonError('Invalid JSON body');
  }
  if (!query || typeof query !== 'string' || !query.trim()) {
    return ndjsonError('Missing query');
  }
  if (!Array.isArray(history)) history = [];

  const messages = history
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.text }))
    .concat([{ role: 'user', content: query }]);

  let chatRes;
  try {
    const tChat = Date.now();
    chatRes = await fetch(LLAMA_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLAMA_KEY}`,
      },
      body: JSON.stringify({
        messages,
        data: {
          retrieval_parameters: {
            dense_similarity_top_k: TOP_K,
            enable_reranking: RERANK,
            rerank_top_n: RERANK_TOP_N,
          },
          llm_parameters: {
            model_name: MODEL,
            system_prompt: SYSTEM_PROMPT,
            temperature: TEMPERATURE,
            // The model's own inline [citation:uuid] tags aren't rendered by this UI —
            // we build citation chips separately from the "sources" stream annotation.
            use_citation: false,
          },
        },
      }),
    });
    if (!chatRes.ok) throw new Error(`HTTP ${chatRes.status}`);
    console.log('[timing] chat request started ms:', Date.now() - tChat);
  } catch (err) {
    return ndjsonError(`LlamaCloud chat failed: ${err.message}`);
  }

  const encoder = new TextEncoder();

  // LlamaCloud's pipeline chat endpoint streams the Vercel AI SDK "data stream protocol":
  // each line is `<prefix>:<jsonValue>`. `0` = text delta (JSON string), `8` = message
  // annotations (JSON array; we look for a {type:"sources", data:{nodes:[...]}} entry
  // carrying the retrieved chunks used for citations), `3` = error, `d`/`e` = finish parts.
  const stream = new ReadableStream({
    async start(controller) {
      let gotDelta = false;
      let finishReason = null;
      const seen = {};
      const citations = [];

      function addCitationsFromNodes(nodes) {
        (nodes || []).forEach((n) => {
          const meta = n && n.metadata;
          const fileName = meta && meta.file_name;
          if (!fileName || seen[fileName]) return;
          seen[fileName] = true;
          citations.push({ label: fileName.replace(/\.pdf$/i, '') });
        });
      }

      try {
        const reader = chatRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line) continue;

            const sep = line.indexOf(':');
            if (sep === -1) continue;
            const prefix = line.slice(0, sep);
            const rest = line.slice(sep + 1);

            if (prefix === '0') {
              let text;
              try {
                text = JSON.parse(rest);
              } catch {
                continue;
              }
              if (typeof text !== 'string' || !text) continue;
              gotDelta = true;
              controller.enqueue(encoder.encode(JSON.stringify({ type: 'delta', text }) + '\n'));
            } else if (prefix === '8') {
              let parts;
              try {
                parts = JSON.parse(rest);
              } catch {
                continue;
              }
              if (!Array.isArray(parts)) continue;
              parts.forEach((p) => {
                if (p && p.type === 'sources' && p.data && Array.isArray(p.data.nodes)) {
                  addCitationsFromNodes(p.data.nodes);
                }
              });
            } else if (prefix === '3') {
              let msg;
              try {
                msg = JSON.parse(rest);
              } catch {
                msg = rest;
              }
              console.log('[llamacloud] stream error part:', msg);
            } else if (prefix === 'd' || prefix === 'e') {
              try {
                const parsed = JSON.parse(rest);
                if (parsed && parsed.finishReason) finishReason = parsed.finishReason;
              } catch {
                // ignore
              }
            }
          }
        }

        if (!gotDelta) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'delta', text: FALLBACK_ANSWER }) + '\n'));
        } else if (finishReason === 'length') {
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'delta', text: '…' }) + '\n'));
        }

        const finalCitations = citations.slice(0, MAX_CITATIONS);
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'citations', citations: finalCitations }) + '\n'));
      } catch (err) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: `LlamaCloud stream failed: ${err.message}` }) + '\n'));
      } finally {
        console.log('[timing] total ms:', Date.now() - tStart);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
};

export const config = { path: '/.netlify/functions/ask' };
