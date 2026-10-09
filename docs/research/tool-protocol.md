> Research note from the initial build (2026-10-09). The raw workspace referenced as `<research-workspace>` (captures, clones, scripts) was not preserved; the findings below are.

# Track report: prompt-based tool-calling protocol for ChatGPT-web models (toolproto)

Date: 2026-10-09. Work dir: `<research-workspace>/toolproto`. A working TypeScript prototype of the recommended protocol is in `proto/`. The parser, renderers and prompt builder pass 42 adversarial tests (`npm test`, Node 22.22 native TS) and a fuzz round-trip (0 failures in 3000 cases unless the content contains the conversation's own nonce tags).

---

## 0. Recommendation

1. **Output format.** Use an XML-ish `invoke`/`parameter` envelope, the design Anthropic documents for prompt-based tool use:
   - String values are written raw.
   - Values of any other type are written as JSON.
   - Every tag gets a **random 4-character per-conversation namespace prefix**, e.g. `<q7tx:tool_calls>`. This is Anthropic's `antml:` trick with a random prefix, so file content can only collide if it contains this conversation's own tags.
2. **Parser layers.**
   - A strict nonce path that cannot collide with content.
   - A lenient fallback: any or no prefix, Anthropic-style `<function_calls>`, closers accepted only when followed by protocol structure, backtracking, a JSON fallback, and schema-guided type coercion.
   - Truncation and hallucination guards.
3. **No stop sequences on ChatGPT web.** The bridge has to make up for this in three ways:
   - Truncate everything after the last closer.
   - Have the extension **click Stop as soon as `</P:tool_calls>` appears in the stream**.
   - Tell the model in the next message when text was discarded.
4. **Tool definitions.**
   - Render them as Harmony-style TypeScript signatures, the format GPT models are trained on.
   - Send core tools in full and compress the rest.
   - Send the definitions **once per ChatGPT conversation**, then send only deltas (new results and user text) in the same conversation.
5. **Results.** Use `<P:results><P:result call="1" tool="Read" target="…" status="ok|error">…</P:result></P:results>` with:
   - A sentinel fallback when the content would collide with the closer.
   - Head and tail truncation of large outputs.
   - Image placeholders, or attachments if the extension can upload them.

---

## 1. Evidence

### 1a. Measured locally (high confidence)
I ran `claude` 2.1.295 (latest on npm; `@anthropic-ai/claude-agent-sdk` is 0.3.295) against a fake Anthropic endpoint (`capture_server.py`; captures in `cap/`). It ran on port 29473/29474; port 18765 was already taken by a webGPT4CC bridge, which I did not touch.

- **Request fields:** `model`, `system` (array of text blocks), `tools`, `messages`, `max_tokens: 128000`, `thinking: {type:"adaptive", display:"omitted"}`, `context_management: {edits:[{type:"clear_thinking_20251015", keep:"all"}]}`, `output_config: {effort:"medium"}`, `stream: true`, `metadata.user_id` (a JSON string).
  - System block 0 is `x-anthropic-billing-header: cc_version=2.1.295.…; cc_entrypoint=remote;`. Drop it.
  - **`messages[]` contains a `role: "system"` message** after the first user message (the "# Environment …" block, about 9.7K chars). The bridge has to accept it and render it.
- **Tool size:** 31 to 37 tools, 58K to 133K chars of tool JSON in this environment. This is a remote, plugin-heavy setup with Artifact, Workflow, SendMessage and similar tools; there was no Grep or Glob here. Tool descriptions dominate the size.
- **tool_result formats:**
  - Read: `"1\tline one\n2\t…"`.
  - Bash failure: `"Exit code 3\nout\nerr"` with `is_error: true`.
  - Missing file: `"File does not exist. Note: your current working directory is …"` with `is_error: true`.
  - `cache_control` can appear on tool_use and tool_result blocks. Ignore it.
- **Auxiliary requests:** with no tools and `max_tokens: 3072`, Claude Code sends a status classifier ("decide which of four states…"). It retries with "Previous response was not valid JSON. Respond with ONLY the JSON object". These would burn ChatGPT messages. The bridge should detect tool-less utility requests and answer them locally or by heuristics. That is another track, but it is quota-critical.
- **jsonrepair 3.15.0 corrupts silently:** `"\d+\.\d+"` becomes `d+.d+` and `"C:\Users\me"` becomes `C:Usersme`. Any JSON leniency layer must first double backslashes that don't start a valid JSON escape. `fixInvalidEscapes` in the prototype does this.

### 1b. Sources
| Claim | Source | Conf. |
|---|---|---|
| Anthropic's prompt-tool rule: "String and scalar parameters should be specified as is, while lists and objects should use JSON format. Note that spaces for string values are not stripped. The output is not expected to be valid XML and is parsed with regular expressions." | platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use (fetched today) | high |
| Anthropic's legacy prompt tools used `<function_calls><invoke><tool_name>…<parameters>…`, results in `<function_results><result><tool_name>…<stdout>…`, and `stop_sequences=["</function_calls>", "\n\nHuman:"]`. Stop sequences are exactly what we lack on the web. | github.com/anthropics/anthropic-tools `tool_use_package/*.py` | high |
| Harmony renders tool definitions as TypeScript: `namespace functions { // desc\n type f = (_: { // p desc\n p?: T, // default: x }) => any; }`. Calls are `to=functions.f <|constrain|>json`. | github.com/openai/harmony docs/format.md, src/encoding.rs (`json_schema_to_typescript`) | high (gpt-oss) |
| Current ChatGPT models get tool namespaces in the same TS style (`## Namespace: python … type exec = (FREEFORM) => any;`, "By default, the input for each tool call is a JSON object"). | Leaked GPT-5.5 Thinking (2026-05-23) and GPT-5.6 Sol (2026-08-22) prompts, asgeirtj/system_prompts_leaks | low-med (unverified) |
| OpenAI moved large code payloads out of JSON: "apply_patch … This is a FREEFORM tool, so do not wrap the patch in JSON". GPT-5 "custom tools" take plaintext and optional CFG/Lark grammars. | openai/codex `codex-rs/core/gpt_5_1_prompt.md`; developers.openai.com GPT-5 docs and cookbook | high |
| Code written inside JSON scores worse: GPT-4o-05-13 60.0% (markdown) vs 59.6% (JSON); 4o-08-06 60.8 vs 57.6 (56.9 strict); Sonnet 3.5 60.5 vs 54.1. | aider.chat/2024/08/14/code-in-json | high (2024 models) |
| Models fall back to normal delimiters: aider dropped 4-backtick fences because "LLMs ignore and revert to triple-backtick (#2879)". Aider's own block parser is lenient (`^<{5,9} SEARCH>?\s*$`). | Aider-AI/aider `base_coder.py`, `editblock_coder.py` | high |
| Content collisions with closing tags happen in practice: Roo's parser uses `lastIndexOf('</content>')` "for robustness against nested tags". Roo-Code main has since switched to "provider-native tool-calling … Do not include XML markup". | RooCodeInc/Roo-Code v3.25.0 `parseAssistantMessageV2.ts`; main `tool-use.ts` | high |
| Agentic coding models from 2025 use one tag per parameter with raw values: Qwen3-Coder `<tool_call><function=N><parameter=K>…</parameter>`, MiniMax-M2 `<minimax:tool_call><invoke name><parameter name>`, GLM-4.5 `<arg_key>/<arg_value>`. vLLM's Qwen3 parser strips one leading and one trailing `\n`, ends values leniently at `</parameter>`, the next `<parameter=`, `</function>` or end of text, and converts types using the schema. | vLLM v0.10.2 `qwen3coder_tool_parser.py`; MiniMax HF docs; vLLM/EasyDeL GLM parsers | high (formats); rationale is my inference |
| Toolify (prompt-injected function calling): a random trigger `<Function_XXXX_Start/>` per process, `<function_calls><function_call><tool>…<args_json><![CDATA[json]]>`. Its prompt explicitly warns against mangling `-i` to `i`. It retries on parse failure, ignores triggers inside think blocks, and detects calls while streaming. | funnycups/Toolify `main.py` | high |
| GPT honours an explicit request not to browse: "You *must* browse … using `web.run` … unless the user explicitly asks you not to browse the web". Custom instructions are injected as a **user**-role `user_editable_context` message, memories as assistant `model_editable_context`. Output may contain `:::writing{…}` blocks. Channels are analysis/commentary/final/summary. | Leaked GPT-5.5 Thinking prompt | low-med |
| ChatGPT context: Thinking 196K; Instant 32K (Plus) or 128K (Pro). Pasting more than about 10K chars may turn into an attachment automatically. | BentoML/TechRadar (Aug 2025); Windows Report (date not verified) | med / low |
| Instruction hierarchy System > Developer > User > Tool; claims of higher authority made at a lower level are discounted. | OpenAI "Instruction Hierarchy" (2024); Model Spec 2025-10-27 | high (exists), med (effect) |
| Natural-language tool selection improved accuracy by +18.4pp; a replication had mixed results. | arXiv 2510.14453; 2607.03953 | med |

---

## 2. Candidate output formats

| Format | How reliably GPT produces it | Escaping failures | Delimiter collisions | Streaming | Verdict |
|---|---|---|---|---|---|
| **(a) Per-parameter XML: raw strings, JSON for everything else** (Anthropic legacy, Qwen3-Coder, MiniMax) | High. GPT reproduces tag markup from examples very reliably, and the shape is widely seen in training data (Claude, Cline, Qwen). | None for strings: code, regexes, Windows paths, quotes and `<![CDATA[` stay verbatim. Possible: the model HTML-escapes (`&lt;`), adds CDATA or quotes, or JSON-escapes a string. All detectable. | **Real risk** with fixed tags: content containing `</parameter>` or `</invoke>` (agent prompts, XML, this repo's own tests). Roo saw this with `</content>`. Fix: **nonce prefix** plus closers accepted only before protocol structure, plus backtracking. | Excellent. The opener is unique, prose before it streams, and the closer gives an early stop signal. | **Use this**, with a nonce prefix. |
| (b) JSON object in a ```json fence | Highest syntactic familiarity (native GPT tool arguments are JSON). | Code inside JSON strings: invalid escapes (`\d`, `\.`, `C:\`), raw newlines, unescaped quotes, `\b` read as backspace. jsonrepair silently drops backslashes (measured). Aider data shows code quality drops. About 5–15% more tokens for code. | **Collision-free by construction** if the closer must start a line, since a valid JSON string has no raw newline. | Poor until the JSON closes; needs partial-JSON parsing. | Use as a fallback parser only. |
| (c) JSON inside an XML wrapper (Hermes `<tool_call>{…}</tool_call>`, Toolify `args_json` + CDATA) | High | Same as (b). CDATA adds a second layer: `]]>` occurs in real code (`if (a[b[i]]>0)`), and models won't split CDATA correctly. | Same as (b) for the wrapper; CDATA collisions are possible. | Wrapper allows early detection. | No better than (a) for code. |
| (d) Heredoc sentinel with a random nonce (`<<'END_k7x2'` … `END_k7x2`) | Medium. Unfamiliar per-value delimiters drift: models fall back to `EOF`, the way aider saw 4-backtick fences revert. | None | Collision-proof if the nonce is copied. | Good | Use for the **input** side (the bridge generates it); not for output. |
| (e) Length prefix | Low. LLMs cannot count characters. | — | Collision-proof in theory | — | Rejected. |
| (f) ChatGPT-native tool calls (Harmony `to=functions.X`) | Not reachable. We can't add tools to ChatGPT's toolset or produce its special tokens. | — | — | — | Rejected. Do borrow the **TS signature style** for definitions, but namespace them so the model doesn't try native calls. |
| (g) `apply_patch` V4A for edits | Very high for GPT-5.x (trained on it; Codex uses it freeform). | None | Line-based markers (`*** Begin Patch`) | Good | Optional v2: accept `*** Begin Patch` and translate to Edit/Write calls (old string = context + removed lines, new string = context + added lines). Medium confidence; not for v1. |

**Why the prefix is a nonce and not a fixed name.** Users of this project are often agent developers who edit prompt files containing `<function_calls>`, `<invoke>` and `<parameter>`, and the project will edit its own parser fixtures. A random per-conversation prefix makes accidental collisions effectively impossible.

Fuzz results (`proto/fuzz.ts`, renderer output fed to the parser):
- Content built from `</parameter>`, `</invoke>`, `</function_calls>`, fences, quotes, backslashes, "Tool result:", `]]>` and similar atoms: **0 failures in 3000 cases**. The 2–3 intended CDATA unwraps per run are excluded from that count.
- With the conversation's **own** nonce tags in content: about 15% fail (442–504 of 3000 across runs). That is the remaining risk, handled by nonce rotation (§3.6).

---

## 3. Recommended spec ("TTP/1")

### 3.1 Nonce
`P = [a-hjkmnp-z][a-hjkmnp-z2-9]{3}` (no 0/o/1/l/i), e.g. `q7tx`.
- Generate one per ChatGPT conversation and store it with the conversation mapping.
- For full-replay mode, derive it deterministically (HMAC of the session's first user message) so that replayed history uses the same prefix.
- Tag matching is case-insensitive.

### 3.2 Output grammar (model to bridge)
```
reply      := prose? block+ trailing?          ; trailing is discarded
block      := "<P:tool_calls>" NL invoke+ "</P:tool_calls>"
invoke     := "<P:invoke name=\"" TOOL "\">" NL param* "</P:invoke>" NL
param      := "<P:parameter name=\"" KEY "\">" VALUE "</P:parameter>" NL
VALUE      := raw text                          if the schema type is string / string enum
            | JSON                              otherwise (number, boolean, array, object, null)
```
Value rules:
- Strip one leading newline (`^[ \t]*\n`) and one trailing newline (`\n[ \t]*$`). This is "block form": the opening tag, then a newline, the content, a newline, and the closing tag. Write content gets a final `\n` restored if it was written in block form.
- Everything else is kept verbatim: no unescaping, no trimming of inline values.
- Do not strip trailing newlines more cleverly than this. A rule like "keep the trailing newline for multi-line values only" corrupts Edit when the old string spans several lines and the new string is one line: the lines get joined. Uniform stripping keeps the old/new pair consistent (test 25).

Example (exactly what the prompt shows the model):
```
I'll check the config and run its tests at the same time.
<q7tx:tool_calls>
<q7tx:invoke name="Read">
<q7tx:parameter name="file_path">/home/me/app/src/config.ts</q7tx:parameter>
</q7tx:invoke>
<q7tx:invoke name="Edit">
<q7tx:parameter name="file_path">/home/me/app/src/util.py</q7tx:parameter>
<q7tx:parameter name="old_string">
def greet(name):
    return "Hi " + name
</q7tx:parameter>
<q7tx:parameter name="new_string">
def greet(name: str) -> str:
    return f"Hello, {name}!\n"  # <b>raw</b>
</q7tx:parameter>
</q7tx:invoke>
<q7tx:invoke name="TodoWrite">
<q7tx:parameter name="todos">[{"content":"Fix greet","status":"in_progress","activeForm":"Fixing greet"}]</q7tx:parameter>
</q7tx:invoke>
</q7tx:tool_calls>
```
- The model **never emits ids**. The bridge generates `toolu_…` ids and maps them in order.
- Parallel calls are multiple `invoke` elements; Claude Code orders and executes them.

### 3.3 Results (bridge to model; input side)
```
<q7tx:results>
<q7tx:result call="1" tool="Read" target="/abs/a.ts" status="ok">
1	line one
</q7tx:result>
<q7tx:result call="2" tool="Bash" target="Run tests" status="error">
Exit code 3
…
</q7tx:result>
</q7tx:results>
```
- `call` is the 1-based order of the calls in the previous reply.
- `target` is a ≤80-character summary of the key argument: file_path, Bash description or command, pattern, url.
- The bridge controls this direction, so collisions are checked exactly: if the body contains `</P:result>`, use `sentinel="END_XXXXXX"` and end the body with that sentinel line. Do **not** alter content (no zero-width characters), because the model copies it into old strings.

### 3.4 Conversation layout
- **Bootstrap message** (first message of a ChatGPT conversation): protocol rules (about 4.3K chars) + `# HARNESS INSTRUCTIONS <P:harness>…</P:harness>` + `# TOOLS <P:tools>…</P:tools>` + optional `# CONVERSATION SO FAR <P:transcript>…` + `# CURRENT TURN` + footer. See `proto/src/prompt.ts` (`protocolRules`, `buildBootstrap`).
- **Delta message** (every later message): `<P:results>…` + any new user text + one-line footer. Optional `# TOOLS UPDATE` when the hash of the tool set changes, or a nonce-rotation note.
- **Transcript replay**:
  ```
  <P:transcript>
  <P:turn role="user|assistant|harness">
  …
  </P:turn>
  …
  </P:transcript>
  ```
  - Previous assistant calls are re-rendered in **exactly** the output format, which acts as in-context examples.
  - Claude Code's `role:"system"` messages become `role="harness"` turns.
  - Thinking blocks are dropped.

### 3.5 Incremental vs full replay (quota-critical)
- Keep a map: `hash(messages[0..k])` → `{conversation_id, last_message_id, P, toolsetHash}`.
- If an incoming request's messages equal the stored prefix plus new tail turns, send **only the delta** in the same ChatGPT conversation. That is one message per agent turn, and tool definitions are sent once.
- Fall back to a new conversation with full replay after compaction, history edits, model switch, a subagent session, or a missing mapping.
- Full replay should elide old tool results (`[result elided: 3,402 chars]`) to fit the message size.

### 3.6 Nonce rotation
If any tool result or user text contains `P:` tags (e.g. the model reads bridge logs of this conversation):
- Pick a new P.
- Prepend `(Protocol note: from now on use the tag prefix "new:" instead of "old:")`.
- Accept both prefixes for one turn.

---

## 4. Presenting tool definitions compactly

**Format.** TypeScript signatures, the Harmony style GPT models are trained on. Wrap them in our own `<P:tools>` section, and say they are called **only** with the text block, so the model doesn't try native calls.
```
// Performs exact string replacement in a file.
// - You must Read the file in this conversation before editing, or the call will fail.
// …
type Edit = (_: {
  file_path: string, // The absolute path to the file to modify
  old_string: string, // The text to replace
  new_string: string, // The text to replace it with (must be different from old_string)
  replace_all?: boolean, // Replace all occurrences of old_string (default false)
}) => any;
```
Conversion rules (`tsType` in `protocol.ts`):
- `enum` becomes a union of literals.
- `anyOf`/`oneOf` become a union.
- Arrays become `T[]` or `Array<{…}>`, with `/* min N, max M */`.
- `required` is shown with `?`.
- Keys that aren't identifiers are quoted: `"-i"?: boolean`. This keeps hyphens visible; Toolify had to warn models about dropping them.
- `default` goes into a comment unless the description already mentions it.
- Drop `$schema`, `additionalProperties`, `type: object`.

Measured on the captured 37-tool request (`size.ts`, `size2.ts`):

| Rendering | Chars |
|---|---|
| Raw tool JSON | 132,703 |
| TS, all descriptions in full | 109,641 (−17%) |
| Core tools in full + others compressed to ≤400 chars | **48,869 (−63%)** |
| Everything compressed to ≤200 chars | 37,265 (−72%) |
| Core tools only, in full (Agent, Bash, Edit, NotebookEdit, Read, Skill, WebSearch, Write) | 12,484 |
| One line per non-core tool | 3,169 |

Policy:
1. Core tools in full: Bash, Read, Edit, Write, Glob, Grep, TodoWrite, Agent/Task, WebFetch, WebSearch, NotebookEdit, AskUserQuestion, Skill. Their descriptions hold rules that matter, such as "Read before Edit", "don't use cat/sed", and the git rules.
2. Other tools: the first paragraph, plus lines containing MUST/NEVER/IMPORTANT/Do not/only/fails/instead, plus the typed signature. Better still, **ship hand-written or LLM-written summaries keyed by a hash of each built-in Claude Code description** and use the heuristic only for unknown and MCP tools. The heuristic can keep a bullet without the heading that gave it meaning; I observed this with an EnterWorktree "use git commands instead" bullet.
3. Make the tool allow/deny list configurable. Remote-only tools (Artifact*, Cron*, PushNotification, ShowOnboardingRolePicker, Suggest*) are usually worth dropping.
4. Never hard-code example calls to tools that may be absent: Grep and Glob were not in the captured toolset. Build the examples from the tools that are present.
5. Budget: the bootstrap I built from the capture is **59K chars (~15K tokens)**. That fits GPT-5 Thinking (196K) but **not GPT-5 Instant on Plus (32K)** once ChatGPT's own system prompt is added (the leaked GPT-5.5 one is ~116K chars). Recommend Thinking models, or a "lite" toolset.

---

## 5. Tool results and transcript replay

- **is_error**: `status="error"`. The text is passed through unchanged; Claude Code's messages are already informative.
- **Tool result content arrays**:
  - Text blocks are concatenated.
  - Images: if the extension can attach files, upload them and write `[image #1 (image/png) attached to this message]`. Otherwise write `[image omitted: image/png, 34 KB; the bridge cannot forward images]`.
  - Unknown blocks (e.g. `tool_reference`) become `[<type> block omitted]`. If deferred tools ever appear (`defer_loading` / `tool_reference`), expand them into the referenced TS signature.
- **Large outputs**:
  - Cap each result (default 20K chars) keeping 60% head and 40% tail, with `[... N characters omitted by the bridge; narrow the command or use offset/limit ...]`.
  - Cap the whole message too: truncate the largest results first and never truncate errors.
  - Claude Code already limits Bash and Read output. The real limit is the ChatGPT composer: test whether programmatic insertion avoids the reported paste-to-attachment conversion above ~10K chars. Attachments may be retrieved via file_search instead of placed in full context, which is unacceptable for Edit-exact text (low-med confidence).
- **Earlier assistant tool calls**: re-render them with `renderAssistantCalls`, using block form for multi-line strings and JSON otherwise. The round trip is lossless (test 37), with one exception: Write content without a trailing newline gets one added.
- **System reminders**: keep `<system-reminder>` blocks inside user messages and results as they are. They are harness instructions.

---

## 6. Prompting techniques (wording is in `proto/src/prompt.ts` `protocolRules`)

**(a) Stop after the calls and never invent results.**
- In the prompt:
  - State the reason: "The bridge runs your calls after your reply ends and sends results in my next message."
  - "Stop writing immediately after `</P:tool_calls>`. Never write tool results, never guess outputs, never write `<P:results>`."
  - Show the exact results format, so the model knows results come from *me*.
  - Repeat a one-line footer at the end of every message, because the most recent instruction weighs most.
- Enforcement, since there are no stop sequences (unlike Anthropic's legacy `stop_sequences=["</function_calls>"]`):
  - (1) The streaming scanner sets `blockClosed`, and the extension clicks **Stop** immediately. This saves time and keeps fabricated text out of the ChatGPT conversation history.
  - (2) The parser drops everything after the last block, and anything from a result-like line on (`<P:result`, `Tool result:`, `Output:` …), setting `hallucinatedResults`.
  - (3) If junk was not stopped in time, the next delta says "your previous message continued after `</P:tool_calls>`; that text was discarded".
  - (4) If the reply hit the length limit, the extension clicks "Continue generating" before parsing. Never execute a call cut off mid-parameter: a truncated Write writes a half file.

**(b) Batch to save quota.**
- In the prompt:
  - "each reply you write costs me one message from a limited quota". GPT models respond well to an explicit cost.
  - "Batch independent calls … only wait when a call depends on an earlier result".
  - The main example shows 3 independent calls in one block.
- Add: never send a reply that contains only TodoWrite; batch it with real work.
- Add: "never Edit a file you haven't seen". Read and Edit in the same batch means editing blind.

**(c) No built-in ChatGPT tools.**
- In the prompt, list them explicitly: web search/browsing, python/code interpreter, canvas, image generation, memory, file search, connectors/apps. Add "**I am explicitly asking you not to browse**". The leaked prompt's browse mandate carves out exactly this case.
- Add: "Your own sandbox (/mnt/data, python, containers) is NOT my computer". Thinking models have a `container`/`python` namespace and may "test" code there.
- Product settings:
  - Temporary Chat, or turn off Memory and "Reference chat history". Memories and recent chats are injected as context.
  - A dedicated Project or Custom GPT with capabilities unchecked (low-med confidence that Custom GPTs still allow model choice).
- Detection (cross-track; medium confidence on field names): in `/backend-api/conversation/{id}` JSON, an assistant message whose `recipient` is not `"all"` (e.g. `web.run`, `python`, `canmore.*`, `bio`, `image_gen.*`) is a built-in tool call. Warn, and send a corrective delta.
- Take only final-channel text; ignore `thoughts`/commentary parts.
- An **empty** final reply (`empty: true`) usually means the answer went to canvas or a tool.
- Strip ChatGPT's private-use citation and entity markers (U+E200–U+E2FF range, medium confidence) and `:::writing{…}` fences from prose.

**(d) Treat the harness system prompt as authoritative.**
- Frame it honestly: the user is relaying their own tool's instructions, and they apply for the whole conversation and override ChatGPT's usual habits.
- **Do not spoof** `system:`, `<|im_start|>system` or "OpenAI instructions". Instruction-hierarchy training discounts claimed authority at the user level and may trigger injection-resistance behaviour.
- Custom or Project instructions arrive as user-role context, so they persist but carry no extra authority.
- Rewrite identity lines that make GPT argue about who it is: "You are Claude Code, Anthropic's official CLI…", "You are powered by the model named…", "knowledge cutoff…". Drop the billing-header block. `rewriteHarnessSystem()` does this.

---

## 7. Parser algorithm (implemented in `proto/src/protocol.ts` `parseReply`)

```
parseReply(T, P, tools):
  s ← normalize CRLF→LF
  pos ← 0; blocks ← []; texts ← []
  loop:
    b ← earliest of:
         strict  "<P:(tool_calls|function_calls|tool_use|calls)…>" anywhere, unless preceded by "`" (inline mention)
         lenient "<NS?(tool_calls|function_calls|…)>" at line start (optionally after a ```lang fence line)
         implicit "<NS?invoke … name=" at line start (no wrapper)
    if none: break
    if a block was already seen and text[pos:b] matches RESULT_SIM: hallucinated; discard rest; break
    parse block from b:
      skip ws; "</NS?wrapper>" → end
      "<NS?invoke attrs>" → name ← attr(name) (quotes optional); continueInvoke:
         "</NS?invoke>" → complete if all params closed
         "<NS?(parameter|param|arg) attrs>" → key ← attr(name); value end ←
            1. first strict "</P:parameter>" unless a strict structural tag (\n<P:parameter|<P:invoke|</P:invoke>|</P:tool_calls>) comes first → cut there (missing closer)
            2. else lenient: first "</NS?parameter>" followed by ws + (param|invoke opener|closer|``` line|EOF)
            3. else first lenient closer (warn), else next line-start structural tag (warn), else EOF → UNCLOSED (truncated)
            normalize: strip one leading [ \t]*\n and one trailing \n[ \t]*
         next "<NS?invoke" or "</NS?wrapper>" → implicit close
         RESULT_SIM line → halt (hallucination)
         stray text → BACKTRACK: extend the last param to the next closer of the same family (strict/lenient)
              that is followed by structure, if no param/invoke/wrapper opener lies in between; else skip line (warn)
      ``` fence line inside block → skip
      RESULT_SIM → halt
      block-level stray → BACKTRACK into the last invoke's last param (handles content containing "</parameter>\n</invoke>")
      implicit block → ends at first non-invoke content; else skip line (warn)
    if block not strict and no invoke names a known tool → ROLL BACK (it was prose/markup); continue after its opener
    texts += prose before block (minus a dangling ```xml line); pos ← after block (+ closing fence)
  if no block: JSON fallback (```json / <tool_call>{name, arguments|input|parameters}``` with a known tool name)
  trailing text after last block → discard (keepTrailingText option), flag if RESULT_SIM
  for each invoke:
    name ← exact | strip "functions./tools./harness." | case-insensitive | unknown (pass through; Claude Code errors)
    key  ← exact | "-"+key | _/- swap | case-insensitive
    value ← coerce(raw, schema[key]):
       string-only: CDATA unwrap; one-line JSON-escaped string ("…\n…") → JSON.parse; [opt-in] &lt;&gt; unescape
                    if no raw <>; enum: strip stray quotes
       boolean: true/false/yes/no; null: null/none; number: numeric (quotes allowed)
       array/object: JSON.parse → fixInvalidEscapes → jsonrepair(fixed) → (string[]: split lines)
       union with string: JSON only if it parses to an allowed non-string type, else raw
       no schema: JSON if it starts with [ or {, else raw
    duplicate key: last wins (warn); Write.content in block form: restore trailing "\n"
    complete → toolUses; param unclosed at EOF → incomplete (never executed)
  stop_reason ← toolUses ? "tool_use" : "end_turn"; empty reply → flag for retry
```
**Streaming** (`StreamScanner`):
- Emit prose as it arrives, but hold back the last line if it starts with `<` or a backtick, a trailing partial strict marker, or a just-completed ```lang fence line.
- On the opener, switch to buffering mode.
- Set `blockClosed` on any wrapper closer, which tells the extension to click Stop.
- Emit tool_use blocks after the final parse. One `input_json_delta` with the full JSON is valid Anthropic SSE.

---

## 8. Adversarial test cases (all implemented in `proto/test/adversarial.test.ts`; 42 passing)

1. Single strict call.
2. Prose before a batch of 2 calls.
3. Raw content with `\"`, `\\`, regex `\d`, HTML, `&amp;`, ``` fences, `a[b[0]]>1`, tabs, NBSP and unicode is preserved byte-exact.
4. Content contains unprefixed `<invoke>…</parameter>…</function_calls>` (an agent prompt) with strict closers.
5. Lenient mode (prefix dropped): `</parameter>` inside HTML content is resolved by structural lookahead.
6. Lenient mode: content contains `</parameter>\n</invoke>`, fixed by block-level backtracking.
6b. Self-reference: content contains the strict nonce closer, recovered by backtracking.
6c. A stray comment line between parameters is skipped, not swallowed into the previous value.
6d. Unprefixed `<invoke name="foo">` in prose that names no known tool is rolled back to text.
7. The whole block is wrapped in a ```xml fence.
8. Inline backtick mention of the opener is not a call.
9. Fabricated `<P:results>` and commentary after the block are discarded and flagged.
10. "Tool result:" simulated inside an unclosed block: parsing halts, and the later `rm` call is not executed.
11. Truncated in the middle of a Write content value: incomplete, not executed.
12. `</invoke>` and `</tool_calls>` missing but the parameter is closed: accepted.
13. A parameter closer is missing and the next parameter starts: the value is cut there.
14. Two separate blocks in one reply are merged, and the prose between them is kept.
15. Number (` 10 `, `"20"`), boolean `True`, and a TodoWrite array with a trailing comma.
16. JSON array with invalid escapes keeps its backslashes (`a\.com`, `C:\Users\me`, `\bword\b`).
17. Raw newline inside a JSON string plus a trailing comma.
18. `i` → `-i`, `C` → `-C`, and quoted enum `"content"` → `content`.
19. `functions.Read` → `Read`; `bash` → `Bash`.
20. Unknown tool `web.run` passes through with a warning.
21. Entity unescape only when enabled and no raw markup is present (HTML content is kept).
22. A CDATA-wrapped value is unwrapped.
23. A one-line JSON-escaped string value is decoded.
24. Block-form newline stripping; Write gets its trailing newline back; inline leading spaces and tabs are kept.
25. Edit with a multi-line old string and a single-line new string stays consistent.
26. Uppercase tags, single or unquoted attributes, spaces around `=`.
27. CRLF input.
28. Empty string value (deleting a line).
29. JSON fallback: ```json {"name","arguments"}``` with prose kept.
30. Anthropic-style `<function_calls>` without the nonce.
31. Implicit block with no wrapper, followed by trailing prose.
32. A string|number union.
33. Empty reply is flagged.
34. Duplicate parameter: the last one wins, with a warning.
35. Streaming: the opener split across 3-character chunks never leaks into text, and the close is detected before trailing prose.
36. Streaming: a ```xml opener line is held back.
37. Rendering previous calls and parsing them back gives identical input.
38. Result-renderer collision triggers the sentinel; a 50K error output is truncated.
39. The TS renderer quotes hyphenated keys and renders enums as unions.

Also run `node fuzz.ts` (3000 random contents per mode).

Worth adding once real captures exist:
- Actual GPT-5.x replies that put the block inside canvas or `:::writing`.
- Replies containing citation private-use characters.
- Commentary-channel preambles.
- Replies stopped by the Stop click in mid-block (should be `incomplete`, not executed).
- A model emitting `*** Begin Patch`.

---

## 9. Open risks to check on real chatgpt.com (I could not reach it from here)

1. How reliably GPT-5.x Thinking and Instant (and 5.5/5.6, which the leaks suggest are current) reproduce the `P:` prefix, and whether they wrap the block in fences, canvas or writing blocks. Log `mode` (strict/lenient/json) per reply as the metric.
2. Composer limits: the maximum size of programmatically inserted text before it becomes an attachment or is rejected as "message too long". This determines the bootstrap budget (currently 59K chars with this toolset).
3. Whether clicking Stop keeps the partial assistant message in the conversation tree (believed yes, medium confidence). The delta mode depends on it.
4. How often the model still uses `web.run`, `python` or `canmore` despite the opt-out. Check the `recipient` field.
5. Whether identity rewriting is needed in practice: does GPT refuse or argue with "You are Claude Code"?

---

## Files
Everything is under `<research-workspace>/toolproto/`:

- **Parser and renderers** – `proto/src/protocol.ts`: `parseReply`, `StreamScanner`, `coerceValue`, `fixInvalidEscapes`, `renderTools`, `compressDescription`, `renderResults`, `renderAssistantCalls`, `makeNonce`.
- **Prompt builders** – `proto/src/prompt.ts`: `protocolRules`, `footer`, `rewriteHarnessSystem`, `buildBootstrap`, `buildDelta`, `renderTranscript`.
- **Tests** – `proto/test/adversarial.test.ts` (42 tests; run with `npm test`) and `proto/fuzz.ts`.
- **Generated samples** – `proto/bootstrap_example.txt` (59K-char bootstrap built from the captured request) and `proto/rendered_tools_compressed.txt`.
- **Captures** – `capture_server.py` and `cap/` hold the real Claude Code 2.1.295 request and tool_result payloads. They include the user's email and account metadata, so keep them local.
- **Downloaded sources** – `src/`: Toolify, Cline, Roo, aider, vLLM, Harmony, Codex, the Anthropic docs, the leaked ChatGPT prompts, and the Agent SDK typings.