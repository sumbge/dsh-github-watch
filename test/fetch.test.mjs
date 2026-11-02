/**
 * Every response this plugin reads is a document it then holds whole in memory,
 * and none of those servers is ours. The URL for a registry probe comes from
 * whatever package happens to be on disk, so "the server behaves" is not an
 * assumption available here.
 *
 * The four call sites used to do `await res.json()`, which hands an unbounded
 * body straight to `JSON.parse`. A response that is merely large — or one from
 * something that is not the registry at all — became memory the scan had to
 * hold. Measured on the real endpoints, the largest document is about 16 KB, so
 * the ceiling below has three orders of magnitude of headroom and can only fire
 * on something that is not the answer we asked for.
 *
 * Content-Length is checked first because it is free, and then ignored as
 * evidence: it can be absent on a chunked response and wrong on a lying one, so
 * the bytes are counted as they arrive and the read stops at the limit rather
 * than after it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readJson, MAX_JSON_BYTES, TooLarge } from '../lib/check.mjs'

/** A Response-shaped object whose body yields real byte chunks. */
function response(text, { declared = null } = {}) {
  const bytes = Buffer.from(text, 'utf8')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes))
      controller.close()
    },
  })
  return {
    headers: { get: (k) => (k.toLowerCase() === 'content-length' && declared !== null ? String(declared) : null) },
    body: stream,
    text: async () => text,
  }
}

test('readJson parses a normal document', async () => {
  const got = await readJson(response('{"a":1,"b":[2,3]}'))
  assert.deepEqual(got, { a: 1, b: [2, 3] })
})

test('readJson reports the size it refused', async () => {
  const huge = 'x'.repeat(MAX_JSON_BYTES + 100)
  await assert.rejects(() => readJson(response(huge)), (err) => {
    assert.ok(err instanceof TooLarge, 'not a TooLarge: ' + err.name)
    assert.match(err.message, /响应超过/)
    return true
  })
})

test('a lying content-length is not trusted either way', async () => {
  // Claims to be small, is not. Counting the bytes catches this; believing the
  // header would have let the whole thing through.
  const huge = 'y'.repeat(MAX_JSON_BYTES + 100)
  await assert.rejects(() => readJson(response(huge, { declared: 10 })), TooLarge)
})

test('a large declared length is refused without consuming the stream', async () => {
  // A `ReadableStream` starts pulling on its own, so "was pull called" says
  // nothing about the reader — Node prefetches whether or not anyone reads. What
  // is observable, and what matters, is whether the lock was ever taken: taking
  // it is the reader's act, and it is what would start buffering a body that has
  // already been refused.
  const stream = new ReadableStream({
    pull(controller) { controller.close(); return { done: true } },
  })
  const res = {
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(MAX_JSON_BYTES + 1) : null) },
    body: stream,
  }
  await assert.rejects(() => readJson(res), TooLarge)
  assert.equal(stream.locked, false, 'it took the lock on a body it had already refused')
})

test('the read stops at the ceiling instead of after it', async () => {
  let sent = 0
  const chunk = new Uint8Array(64 * 1024).fill(120)
  const stream = new ReadableStream({
    pull(controller) {
      sent += chunk.byteLength
      controller.enqueue(chunk)
      if (sent > MAX_JSON_BYTES * 4) controller.close()
    },
  })
  const res = { headers: { get: () => null }, body: stream }

  await assert.rejects(() => readJson(res), TooLarge)
  assert.ok(sent <= MAX_JSON_BYTES + chunk.byteLength,
    'it kept reading past the limit: ' + sent + ' bytes')
})

test('a body that is not JSON fails as a parse error, not as a size error', async () => {
  await assert.rejects(() => readJson(response('<html>not json</html>')), (err) => {
    assert.ok(!(err instanceof TooLarge), 'a small non-JSON body was reported as too large')
    return true
  })
})

test('the no-stream fallback is bounded too', async () => {
  // A Response with no body stream used to fall through to res.json(), which is
  // exactly the unbounded path this function replaces.
  const huge = 'z'.repeat(MAX_JSON_BYTES + 10)
  const res = {
    headers: { get: () => null },
    body: null,
    text: async () => huge,
  }
  await assert.rejects(() => readJson(res), TooLarge)
})

test('the ceiling is far above any real document', () => {
  assert.equal(MAX_JSON_BYTES, 8 * 1024 * 1024)
  // The largest document these four endpoints returned when measured was 16 KB:
  // 512× headroom. Anything closer would be a ceiling that real traffic touches.
  assert.ok(MAX_JSON_BYTES >= 16 * 1024 * 512, 'the ceiling is too close to real traffic')
})
