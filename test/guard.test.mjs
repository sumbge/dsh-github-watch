/**
 * Every write endpoint must refuse a request a web page could have made.
 *
 * The host serves this Settings section from the same origin as its own API, and
 * a page on any other site can still reach these routes: the browser sends the
 * request, the local server answers it, nobody sees a prompt. Before this guard
 * existed, a `text/plain` POST from anywhere deleted real directories — the
 * delete endpoint ran `rm(path, { recursive: true })` after a `startsWith` check
 * on a path it had not normalised.
 *
 * The test enumerates the write paths instead of naming one: a route added later
 * that forgets to be safe still has to pass through the same gate, and if it does
 * not, the loop below grows and fails.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { isolate } from './helpers.mjs'

// The steps resolve the data directory at import time, so the override comes first.
const box = isolate('gw-guard-')

writeFileSync(join(box.dir, 'inventory.json'), JSON.stringify({
  projects: [{ name: 'bun', kind: 'npm', version: '1.4.4', path: 'C:/fake/bun', exists: true }],
  plugins: [],
  tools: [],
  scanned_at: '2026-11-01T18:00:00+08:00',
}), 'utf8')

const { route } = await import('../index.js')

const MARKER = 'x-dsh-github-watch'

/**
 * Fake request/response pair.
 *
 * `body` turns the request into a stream, because a request that clears the guard
 * reaches `readJsonBody`, which waits for `data`/`end`. A refusal returns before
 * that point and never touches the stream — which is itself part of what the
 * tests assert: the guard runs first.
 */
function call(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.url = path
    req.method = method
    req.headers = headers
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(raw) {
        let parsed = null
        try { parsed = JSON.parse(raw) } catch { parsed = raw }
        resolve({ code: this.statusCode, headers: this.headers, body: parsed })
      },
    }
    const next = () => resolve({ code: 0, body: null, next: true })
    Promise.resolve(route.handler(req, res, next)).catch(reject)
    setImmediate(() => {
      if (body !== null) req.emit('data', Buffer.from(body, 'utf8'))
      req.emit('end')
    })
  })
}

/** Every endpoint that changes something. Reads are deliberately absent. */
const WRITE_PATHS = [
  '/github-watch/api/github/login',
  '/github-watch/api/github/cancel',
  '/github-watch/api/scan',
  '/github-watch/api/preview-delete',
  '/github-watch/api/delete',
  '/github-watch/api/mute',
  '/github-watch/api/update',
]

const GOOD = { 'content-type': 'application/json', [MARKER]: '1' }

test('a write without the marker header is refused', async () => {
  for (const path of WRITE_PATHS) {
    const got = await call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(got.code, 403, path + ' answered ' + got.code)
    assert.equal(got.body.ok, false, path + ' did not say no')
    assert.equal(got.body.code, 'error.proto.forbidden')
    assert.match(got.body.error, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('a form or text/plain write is refused even with the marker', async () => {
  // These are the two encodings a browser sends cross-origin without a preflight,
  // so accepting them would make the marker header pointless.
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) {
    const got = await call('/github-watch/api/scan', {
      method: 'POST',
      headers: { 'content-type': type, [MARKER]: '1' },
      body: '',
    })
    assert.equal(got.code, 415, 'content-type ' + JSON.stringify(type) + ' was accepted')
    assert.equal(got.body.code, 'error.proto.contentType')
  }
})

test('a write whose Origin disagrees with Host is refused', async () => {
  const got = await call('/github-watch/api/scan', {
    method: 'POST',
    headers: { ...GOOD, host: '127.0.0.1:52271', origin: 'https://evil.example' },
    body: '',
  })
  assert.equal(got.code, 403, 'a cross-origin write got through')
  assert.equal(got.body.code, 'error.proto.crossOrigin')
  assert.match(got.body.error, /evil\.example/)
})

test('a write from the page itself is allowed through', async () => {
  const got = await call('/github-watch/api/mute', {
    method: 'POST',
    headers: { ...GOOD, host: '127.0.0.1:52271', origin: 'http://127.0.0.1:52271' },
    body: JSON.stringify({ names: ['bun'], muted: true }),
  })
  assert.notEqual(got.code, 403, 'the plugin’s own request was refused')
  assert.notEqual(got.code, 415, 'the plugin’s own request was refused')
})

test('a same-origin write works when the browser sends no Origin at all', async () => {
  // A same-origin navigation-style POST and every non-browser client land here.
  const got = await call('/github-watch/api/mute', {
    method: 'POST',
    headers: { ...GOOD, host: '127.0.0.1:52271' },
    body: JSON.stringify({ names: ['bun'], muted: true }),
  })
  assert.notEqual(got.code, 403)
})

test('reads are untouched by the guard', async () => {
  // No marker, no content-type, no Origin — a plain GET still has to work, or the
  // page would need a preflight just to paint.
  for (const path of ['/github-watch/api/projects', '/github-watch/api/github', '/github-watch/api/scan']) {
    const got = await call(path)
    assert.equal(got.code, 200, path + ' answered ' + got.code)
  }
})

test('HEAD is treated as a read', async () => {
  const got = await call('/github-watch/api/projects', { method: 'HEAD' })
  assert.notEqual(got.code, 403, 'HEAD was gated as a write')
})
