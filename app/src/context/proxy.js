import { randomBytes, randomUUID } from "node:crypto"
import http from "node:http"

import { log } from "./log"
import { applyVariant } from "./variants"

// ---------------------------------------------------------------------------
// Claude Code only speaks the Anthropic Messages API. Many provider models (GLM, Kimi K2, MiMo,
// GPT, Grok, …) only answer OpenAI Chat Completions or Responses, so Agent Code runs a small local
// server that takes Claude Code's /v1/messages requests and translates them both ways.
// ---------------------------------------------------------------------------











/** Router routes serve one Claude Code process that mixes providers: each request goes where its model lives. */




const ANTHROPIC = "https://api.anthropic.com"
const routes = new Map                  ()
const routers = new Map                ()
let server

function listen() {
  server ??= new Promise        ((resolve, reject) => {
    const instance = http.createServer((req, res) => void handle(req, res))
    instance.on("error", reject)
    instance.listen(0, "127.0.0.1", () => resolve((instance.address()               ).port))
    instance.unref()
  })
  return server
}

/** Register an upstream and return the base URL Claude Code should use for it. */
export async function proxyURL(upstream          ) {
  const port = await listen()
  for (const [token, existing] of routes) if (JSON.stringify(existing) === JSON.stringify(upstream)) return `http://127.0.0.1:${port}/${token}`
  const token = randomBytes(12).toString("hex")
  routes.set(token, upstream)
  return `http://127.0.0.1:${port}/${token}`
}

/** Register a mixed-provider router and return its base URL (Claude Code keeps its own Claude login). */
export async function routerURL(router        ) {
  const port = await listen()
  const token = randomBytes(12).toString("hex")
  routers.set(token, router)
  return `http://127.0.0.1:${port}/${token}`
}

async function readBody(req                      ) {
  const chunks           = []
  for await (const chunk of req) chunks.push(chunk          )
  return Buffer.concat(chunks).toString("utf8")
}

function sendError(res                     , status        , message        ) {
  // Claude Code hung up (interrupt): nobody is left to tell.
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.write(sse("error", { type: "error", error: { type: "api_error", message } }))
    res.end()
    return
  }
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message } }))
}

const sse = (event        , data         ) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

async function handle(req                      , res                     ) {
  const [pathPart, query] = (req.url ?? "").split("?")
  const [, token, ...rest] = pathPart.split("/")
  const route = "/" + rest.join("/")
  // When Claude Code hangs up (an interrupted turn), stop the provider's generation too.
  const abort = new AbortController()
  res.on("close", () => !res.writableFinished && abort.abort())
  const signal = abort.signal
  const router = routers.get(token)
  if (router) return void routed(router, route, query, req, res, signal).catch((error) => {
    if (signal.aborted) return
    log("router error", error)
    sendError(res, 500, error instanceof Error ? error.message : String(error))
  })
  const upstream = routes.get(token)
  if (!upstream) return sendError(res, 404, "unknown Agent Code proxy route")
  try {
    const text = req.method === "POST" ? await readBody(req) : ""
    if (upstream.protocol === "anthropic") {
      // Same protocol: everything goes through as Claude Code sent it, plus the model's variant.
      let payload = text || undefined
      if (route === "/v1/messages" && text) {
        const body = JSON.parse(text)
        applyVariant("anthropic", body, upstream.model)
        payload = JSON.stringify(body)
      }
      const headers                         = {}
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string" && !HOP.has(name) && name !== "x-api-key" && name !== "authorization") headers[name] = value
      return pipe(await anthropicFetch(upstream, route + (query ? "?" + query : ""), req.method ?? "GET", payload, headers, signal), res)
    }
    if (route === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ input_tokens: Math.ceil(text.length / 4) }))
    }
    if (route !== "/v1/messages") return sendError(res, 404, `agentcode proxy does not handle ${route}`)
    const body = JSON.parse(text)
    // Claude Code's session header and the like go through; auth and protocol headers don't.
    const forwarded                         = { ...upstream.headers }
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && name.startsWith("x-") && !name.startsWith("x-api-key") && !name.startsWith("x-stainless")) forwarded[name] = value
    }
    if (upstream.protocol === "responses") await viaResponses(upstream, body, forwarded, res, signal, upstream.model)
    else await viaChat(upstream, body, forwarded, res, signal, upstream.model)
  } catch (error) {
    if (signal.aborted) return
    log("proxy error", error)
    sendError(res, 500, error instanceof Error ? error.message : String(error))
  }
}

const logged = new Set        ()
const HOP = new Set(["host", "content-length", "accept-encoding", "connection", "transfer-encoding"])

async function pipe(response          , res                     ) {
  const headers                         = {}
  response.headers.forEach((value, name) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)) headers[name] = value
  })
  res.writeHead(response.status, headers)
  if (response.body) for await (const chunk of response.body       ) res.write(chunk)
  res.end()
}

async function routed(router        , route        , query                    , req                      , res                     , signal             ) {
  const raw = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(await readBody(req), "utf8")
  let body
  try {
    body = raw ? JSON.parse(raw.toString("utf8")) : undefined
  } catch {}
  const target = typeof body?.model === "string" ? await router.resolve(body.model) : undefined
  if (!target) {
    // A Claude model (or a non-model call): straight through to Anthropic with Claude Code's own login.
    const headers                         = {}
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string" && !HOP.has(name)) headers[name] = value
    const response = await fetch(`${ANTHROPIC}${route}${query ? "?" + query : ""}`, { method: req.method, headers, body: raw, signal })
    return pipe(response, res)
  }
  if (!logged.has(body.model)) {
    logged.add(body.model)
    log("router", body.model, "→", target.upstream.baseURL, target.protocol)
  }
  const value = body.model
  body.model = target.model
  if (route === "/v1/messages/count_tokens") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ input_tokens: Math.ceil((raw?.length ?? 0) / 4) }))
  }
  if (route !== "/v1/messages") return sendError(res, 404, `agentcode router does not handle ${route} for ${target.model}`)
  const { upstream } = target
  if (target.protocol === "anthropic") {
    // Same protocol, other account: swap the Claude login for the provider key and drop Anthropic-only betas.
    applyVariant("anthropic", body, value)
    const response = await anthropicFetch(upstream, "/v1/messages", "POST", JSON.stringify(body), { "content-type": "application/json" }, signal)
    if (!response.ok) return upstreamError(res, response)
    return pipe(response, res)
  }
  if (target.protocol === "responses") await viaResponses(upstream, body, upstream.headers ?? {}, res, signal, value)
  else await viaChat(upstream, body, upstream.headers ?? {}, res, signal, value)
}

/** A request to an Anthropic-protocol provider with its own key. */
function anthropicFetch(upstream          , path        , method        , body                    , headers                        , signal             ) {
  return fetch(upstream.baseURL.replace(/\/+$/, "") + path, {
    method,
    signal,
    headers: {
      "user-agent": "agent-code/1.0",
      "anthropic-version": "2023-06-01",
      ...headers,
      ...(upstream.apiKey ? { "x-api-key": upstream.apiKey, authorization: `Bearer ${upstream.apiKey}` } : {}),
      ...upstream.headers,
    },
    body,
  })
}

async function post(upstream          , path        , payload         , headers                        , signal             ) {
  return fetch(upstream.baseURL.replace(/\/+$/, "") + path, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "user-agent": "agent-code/1.0",
      ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify(payload),
  })
}

async function upstreamError(res                     , response          ) {
  const text = await response.text().catch(() => "")
  let message = text.slice(0, 2000) || response.statusText
  try {
    const json = JSON.parse(text)
    message = json.error?.message ?? json.message ?? message
  } catch {}
  sendError(res, response.status, message)
}

/** Lines of an SSE stream, as `data:` payloads. */
async function* events(response          ) {
  const reader = response.body .getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") return
      try {
        yield JSON.parse(data)
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic request → OpenAI shapes
// ---------------------------------------------------------------------------


const blocks = (content         )          => (typeof content === "string" ? [{ type: "text", text: content }] : ((content           ) ?? []))
const systemText = (system         ) => blocks(system).map((block) => block.text ?? "").join("\n\n")
const toolResultText = (content         ) =>
  typeof content === "string" ? content : blocks(content).map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n")
const dataURL = (block       ) => (block.source?.type === "base64" ? `data:${block.source.media_type};base64,${block.source.data}` : block.source?.url)
const functionTools = (tools                   ) => (tools ?? []).filter((tool) => tool.input_schema)

function chatRequest(model        , body     ) {
  const messages        = []
  const system = systemText(body.system)
  if (system) messages.push({ role: "system", content: system })
  for (const message of body.messages ?? []) {
    const list = blocks(message.content)
    if (message.role === "assistant") {
      const text = list.filter((block) => block.type === "text").map((block) => block.text).join("")
      const reasoning = list.filter((block) => block.type === "thinking").map((block) => block.thinking).join("")
      const calls = list
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }))
      messages.push({
        role: "assistant",
        content: text || (calls.length ? null : ""),
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      })
      continue
    }
    // Tool results become `tool` messages, which must directly follow the assistant's calls.
    for (const block of list.filter((block) => block.type === "tool_result")) {
      messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: (block.is_error ? "Error: " : "") + toolResultText(block.content) })
    }
    const parts = list
      .filter((block) => block.type !== "tool_result")
      .flatMap((block)        =>
        block.type === "text"
          ? [{ type: "text", text: block.text }]
          : block.type === "image"
            ? [{ type: "image_url", image_url: { url: dataURL(block) } }]
            : block.type === "document" && block.source?.type === "text"
              ? [{ type: "text", text: block.source.data }]
              : [],
      )
    if (!parts.length) continue
    messages.push({ role: "user", content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("\n") : parts })
  }
  const tools = functionTools(body.tools).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }))
  const choice = body.tool_choice
  return {
    model,
    messages,
    max_tokens: body.max_tokens,
    stream: !!body.stream,
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
    ...(tools.length ? { tools } : {}),
    ...(tools.length && choice
      ? {
          tool_choice:
            choice.type === "any" ? "required" : choice.type === "tool" ? { type: "function", function: { name: choice.name } } : choice.type === "none" ? "none" : "auto",
        }
      : {}),
  }
}

function responsesRequest(model        , body     ) {
  const input        = []
  for (const message of body.messages ?? []) {
    for (const block of blocks(message.content)) {
      if (message.role === "assistant") {
        if (block.type === "text" && block.text) input.push({ role: "assistant", content: [{ type: "output_text", text: block.text }] })
        else if (block.type === "tool_use")
          input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) })
      } else if (block.type === "tool_result") {
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output: (block.is_error ? "Error: " : "") + toolResultText(block.content) })
      } else if (block.type === "text") input.push({ role: "user", content: [{ type: "input_text", text: block.text }] })
      else if (block.type === "image") input.push({ role: "user", content: [{ type: "input_image", image_url: dataURL(block) }] })
    }
  }
  const tools = functionTools(body.tools).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }))
  const choice = body.tool_choice
  return {
    model,
    input,
    instructions: systemText(body.system) || undefined,
    max_output_tokens: body.max_tokens,
    stream: !!body.stream,
    store: false,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(tools.length ? { tools } : {}),
    ...(tools.length && choice
      ? { tool_choice: choice.type === "any" ? "required" : choice.type === "tool" ? { type: "function", name: choice.name } : choice.type === "none" ? "none" : "auto" }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// OpenAI response → Anthropic stream
// ---------------------------------------------------------------------------

/** Writes Anthropic stream events, opening and closing content blocks as the kind of output changes. */
class AnthropicStream {
          index = -1
          open
           content          = []
  usage = { input_tokens: 0, output_tokens: 0 }
  stopReason = "end_turn"
          res
          model
          streaming

  constructor(res                     , model        , streaming         ) {
    this.res = res
    this.model = model
    this.streaming = streaming
  }

          emit(event        , data         ) {
    if (this.streaming) this.res.write(sse(event, data))
  }

  start() {
    if (!this.streaming) return
    this.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    this.emit("message_start", {
      type: "message_start",
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: this.usage },
    })
  }

          close() {
    if (!this.open) return
    if (this.open.kind === "thinking") this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "signature_delta", signature: "" } })
    this.emit("content_block_stop", { type: "content_block_stop", index: this.index })
    this.open = undefined
  }

          begin(kind                              , block       , key         ) {
    if (this.open?.kind === kind && this.open.key === key) return
    this.close()
    this.index++
    this.open = { kind, key }
    this.content.push(structuredClone(block))
    this.emit("content_block_start", { type: "content_block_start", index: this.index, content_block: block })
  }

  text(text        ) {
    if (!text) return
    this.begin("text", { type: "text", text: "" })
    this.content[this.index].text += text
    this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text } })
  }

  thinking(text        ) {
    if (!text) return
    this.begin("thinking", { type: "thinking", thinking: "", signature: "" })
    this.content[this.index].thinking += text
    this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "thinking_delta", thinking: text } })
  }

  tool(key        , id        , name        ) {
    this.begin("tool", { type: "tool_use", id: id || `toolu_${randomUUID().replace(/-/g, "")}`, name, input: {} }, key)
    this.content[this.index].partial = ""
  }

  toolArguments(key        , json        ) {
    if (!json || this.open?.kind !== "tool" || this.open.key !== key) return
    this.content[this.index].partial += json
    this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: json } })
  }

  finish() {
    this.close()
    for (const block of this.content) {
      if (block.type !== "tool_use") continue
      try {
        block.input = block.partial ? JSON.parse(block.partial) : {}
      } catch {
        block.input = {}
      }
      delete block.partial
    }
    if (this.content.some((block) => block.type === "tool_use") && this.stopReason === "end_turn") this.stopReason = "tool_use"
    if (this.streaming) {
      this.emit("message_delta", { type: "message_delta", delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: this.usage })
      this.emit("message_stop", { type: "message_stop" })
      this.res.end()
      return
    }
    this.res.writeHead(200, { "content-type": "application/json" })
    this.res.end(
      JSON.stringify({
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: this.model,
        content: this.content,
        stop_reason: this.stopReason,
        stop_sequence: null,
        usage: this.usage,
      }),
    )
  }
}

/** The request's size in tokens (~4 characters each), so the live context count starts right, not at 0. */
const estimateInput = (body     ) => Math.ceil(JSON.stringify([body.system ?? "", body.messages ?? [], body.tools ?? []]).length / 4)

const FINISH                         = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" }

async function viaChat(upstream          , body     , headers                        , res                     , signal             , value         ) {
  const request = chatRequest(body.model, body)
  applyVariant("chat", request, value)
  const response = await post(upstream, "/v1/chat/completions", request, headers, signal)
  if (!response.ok) return upstreamError(res, response)
  const out = new AnthropicStream(res, body.model, !!body.stream)
  out.usage = { input_tokens: estimateInput(body), output_tokens: 0 }
  const usage = (value     ) => {
    if (!value) return
    out.usage = { input_tokens: value.prompt_tokens ?? 0, output_tokens: value.completion_tokens ?? 0 }
  }
  out.start()
  if (!body.stream) {
    const json      = await response.json()
    const message = json.choices?.[0]?.message ?? {}
    out.thinking(message.reasoning_content ?? message.reasoning ?? "")
    out.text(message.content ?? "")
    for (const [i, call] of (message.tool_calls ?? []).entries()) {
      out.tool(String(i), call.id, call.function?.name)
      out.toolArguments(String(i), call.function?.arguments ?? "")
    }
    out.stopReason = FINISH[json.choices?.[0]?.finish_reason] ?? "end_turn"
    usage(json.usage)
    return out.finish()
  }
  for await (const chunk of events(response)) {
    usage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    out.thinking(delta.reasoning_content ?? delta.reasoning ?? "")
    out.text(delta.content ?? "")
    for (const call of delta.tool_calls ?? []) {
      const key = String(call.index ?? 0)
      if (call.id || call.function?.name) out.tool(key, call.id, call.function?.name ?? "")
      out.toolArguments(key, call.function?.arguments ?? "")
    }
    if (choice.finish_reason) out.stopReason = FINISH[choice.finish_reason] ?? "end_turn"
  }
  out.finish()
}

async function viaResponses(upstream          , body     , headers                        , res                     , signal             , value         ) {
  const request = responsesRequest(body.model, body)
  applyVariant("responses", request, value)
  const response = await post(upstream, "/v1/responses", request, headers, signal)
  if (!response.ok) return upstreamError(res, response)
  const out = new AnthropicStream(res, body.model, !!body.stream)
  out.usage = { input_tokens: estimateInput(body), output_tokens: 0 }
  const done = (result     ) => {
    out.usage = { input_tokens: result?.usage?.input_tokens ?? 0, output_tokens: result?.usage?.output_tokens ?? 0 }
    if (result?.status === "incomplete") out.stopReason = result.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens"
  }
  out.start()
  if (!body.stream) {
    const json      = await response.json()
    for (const item of json.output ?? []) {
      if (item.type === "reasoning") out.thinking((item.summary ?? []).map((part     ) => part.text).join("\n"))
      else if (item.type === "message") out.text((item.content ?? []).map((part     ) => part.text ?? "").join(""))
      else if (item.type === "function_call") {
        out.tool(item.id ?? item.call_id, item.call_id, item.name)
        out.toolArguments(item.id ?? item.call_id, item.arguments ?? "")
      }
    }
    done(json)
    return out.finish()
  }
  for await (const event of events(response)) {
    switch (event.type) {
      case "response.output_text.delta":
        out.text(event.delta)
        break
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        out.thinking(event.delta)
        break
      case "response.output_item.added":
        if (event.item?.type === "function_call") out.tool(event.item.id ?? event.item.call_id, event.item.call_id, event.item.name)
        break
      case "response.function_call_arguments.delta":
        out.toolArguments(event.item_id, event.delta)
        break
      case "response.completed":
      case "response.incomplete":
        done(event.response)
        break
      case "response.failed":
      case "error":
        log("responses error", JSON.stringify(event).slice(0, 1000))
        out.text(`\n\n[provider error: ${event.response?.error?.message ?? event.message ?? "request failed"}]`)
        break
    }
  }
  out.finish()
}
