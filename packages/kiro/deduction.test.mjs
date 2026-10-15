// The input Kiro reports holds its own agent prompt and the identity frame,
// a fixed size per model; the caller is billed for neither.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { events } = _internal

// frame is one AWS event-stream message with string headers.
function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    hs.push(h)
  }
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + hlen + body.length + 4
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, total)
  v.setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(body, i)
  return out
}

const stream = (...fs) =>
  new ReadableStream({
    start(c) {
      for (const f of fs) c.enqueue(f)
      c.close()
    },
  })

const meta = (inputTokens) => frame({ ":message-type": "event", ":event-type": "metadataEvent" }, { tokenUsage: { inputTokens, outputTokens: 2 } })
const text = (content) => frame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content })

async function inputOf(model, reported) {
  let usage
  for await (const e of events(stream(text("READY"), meta(reported)), model, 0)) if (e.kind === "stop") usage = e.usage
  return usage.input
}

test("Opus: the harness and the frame come out, the caller's tokens stay", async () => {
  // a bare "Reply exactly READY" as measured, then with 1000 tokens of the caller's
  expect(await inputOf("claude-opus-5.5", 7030)).toBe(5)
  expect(await inputOf("claude-opus-5.5", 8030)).toBe(1005)
})

test("Sonnet's harness is a little smaller", async () => {
  expect(await inputOf("claude-sonnet-5.5", 6841)).toBe(5)
})

test("a model not measured uses the default harness size", async () => {
  expect(await inputOf("claude-haiku-5", 6823 + 40)).toBe(40)
})

test("an input under the overhead is left alone", async () => {
  expect(await inputOf("claude-opus-5.5", 120)).toBe(120)
})
