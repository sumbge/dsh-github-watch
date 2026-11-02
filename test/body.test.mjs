/**
 * A request body that is too large has to be refused, not cut off.
 *
 * The first version answered a 1.2 MB body by calling `req.destroy()`. The client
 * saw a connection reset with no status, and the handler's promise never settled
 * (only `end` and `error` resolved it), so the request hung until the socket died.
 * Pressing "delete" once was enough to reach it.
 *
 * These tests drive `readJsonBody` directly: the route handler wraps everything in
 * a try/catch that turns a throw into a 500, which would hide the difference
 * between "refused with 413" and "the server fell over".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { isolate } from './helpers.mjs'

const box = isolate('gw-body-')

const { readJsonBody, MAX_BODY_BYTES, bodyRefusal } = await import('../index.js')

/** A fake request that emits the given body in `chunks` pieces, then ends. */
function streamed(text, chunks = 1) {
  const req = new EventEmitter()
  setImmediate(() => {
    const size = Math.ceil(text.length / chunks) || 1
    for (let i = 0; i < text.length; i += size) {
      req.emit('data', Buffer.from(text.slice(i, i + size), 'utf8'))
    }
    req.emit('end')
  })
  return req
}

test('a normal body parses', async () => {
  const got = await readJsonBody(streamed(JSON.stringify({ names: ['bun'] })))
  assert.equal(got.tooLarge, undefined)
  assert.deepEqual(got.value, { names: ['bun'] })
  assert.equal(bodyRefusal(got), null)
})

test('an empty body is an empty object, not an error', async () => {
  const got = await readJsonBody(streamed(''))
  assert.deepEqual(got.value, {})
  assert.equal(bodyRefusal(got), null)
})

test('malformed JSON is reported, not swallowed', async () => {
  // Silently treating junk as `{}` meant a typo in the client turned into
  // "no names given", which answers 200 and does nothing — the hardest kind of
  // failure to notice.
  const got = await readJsonBody(streamed('{ not json'))
  assert.equal(typeof got.badJson, 'string')
  const bad = bodyRefusal(got)
  assert.equal(bad.code, 400)
  assert.equal(bad.body.code, 'error.proto.invalidJson')
})

test('an oversized body resolves with tooLarge instead of hanging', async () => {
  // 1.2 MB, the size that used to reset the connection.
  const big = JSON.stringify({ pad: 'x'.repeat(1200000) })
  const started = Date.now()
  const got = await readJsonBody(streamed(big, 8))
  const ms = Date.now() - started
  assert.equal(got.tooLarge, true, 'an oversized body was not flagged')
  assert.ok(ms < 500, 'readJsonBody took ' + ms + ' ms; it is waiting on a destroyed socket again')
  const bad = bodyRefusal(got)
  assert.equal(bad.code, 413)
  assert.equal(bad.body.code, 'error.proto.bodyTooLarge')
  assert.match(bad.body.error, new RegExp(String(MAX_BODY_BYTES)))
})

test('the size limit counts bytes, and the constant is 1 MiB', () => {
  assert.equal(MAX_BODY_BYTES, 1048576)
})

test('exactly at the limit still parses', async () => {
  const filler = 'x'.repeat(MAX_BODY_BYTES - 20)
  const text = JSON.stringify({ pad: filler })
  assert.ok(text.length <= MAX_BODY_BYTES)
  const got = await readJsonBody(streamed(text, 4))
  assert.notEqual(got.tooLarge, true, 'a body at the limit was refused')
  assert.equal(got.value.pad.length, filler.length)
})

test('a body that arrives in many small chunks is still assembled', async () => {
  const text = JSON.stringify({ why: '一'.repeat(2000) })
  const got = await readJsonBody(streamed(text, 64))
  assert.equal(got.value.why.length, 2000)
})

test('an aborted upload resolves rather than rejecting', async () => {
  const req = new EventEmitter()
  const pending = readJsonBody(req)
  setImmediate(() => {
    req.emit('data', Buffer.from('{"names":', 'utf8'))
    req.emit('aborted')
  })
  const got = await pending
  assert.equal(bodyRefusal(got), null)
})

test('a socket error resolves rather than rejecting', async () => {
  const req = new EventEmitter()
  const pending = readJsonBody(req)
  setImmediate(() => req.emit('error', new Error('boom')))
  const got = await pending
  assert.equal(bodyRefusal(got), null)
})
