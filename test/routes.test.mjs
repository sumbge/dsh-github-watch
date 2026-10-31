/**
 * End-to-end proof at the HTTP boundary: cold start must paint instantly.
 *
 * Builds the real route handler against a fake req/res, so the timings are what
 * the page would actually see. This is the test for the "two seconds before the
 * list appears" bug: `gh auth status` and `gh api rate_limit` both verify the
 * token over the network, and running them before answering the request made a
 * list of local files wait on GitHub.
 *
 * Data comes from a temp directory, never the operator's real one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './helpers.mjs'

// Import order matters: the steps resolve the data directory at import time, so
// the override has to exist first.
const box = isolate('gw-routes-')

const INVENTORY = {
  projects: [
    { name: 'bun', kind: 'npm', version: '1.4.4', path: 'C:/fake/bun', exists: true },
    { name: 'github-mcp-server', kind: 'dir', version: '2.0.3', path: 'C:/fake/gh', exists: true },
  ],
  plugins: [
    { name: 'dsh-github-watch', profile: 'desktop', version: '0.2.0', install_path: 'C:/fake/gw', installed: true },
  ],
  tools: [],
  discovered: [],
  scanned_at: '2026-10-31T18:00:00+08:00',
}

const REPORT = [
  '# GitHub 项目更新报告',
  '',
  '生成时间：2026-10-31 18:00　｜　共 **2** 个项目',
  '有更新 **0**　上游有新提交 0　已下架 0　已最新 2　失败 0　无上游 0',
  '',
  '## 全部项目',
  '',
  '| 项目 | 类型 | 状态 | 说明 | 更新内容 |',
  '|---|---|---|---|---|',
  '| bun | npm | ✅ 最新 | 本地 1.4.4 = 上游 1.4.4 |  |',
  '| github-mcp-server | release | ✅ 最新 | 本地 2.0.3 = 上游 v2.0.3 ｜ 2026-10-21 |  |',
  '| dsh-github-watch | tags | ✅ 最新 | 本地 0.2.0 = 上游 v0.2.0 |  |',
  '',
].join('\n')

writeFileSync(join(box.dir, 'inventory.json'), JSON.stringify(INVENTORY, null, 2), 'utf8')
writeFileSync(join(box.dir, 'report.md'), REPORT, 'utf8')

const { route } = await import('../index.js')

function call(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const req = { url: path, method }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(body) {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { parsed = body }
        resolve({ code: this.statusCode, ms: Date.now() - t0, body: parsed })
      },
    }
    const next = () => resolve({ code: 0, ms: Date.now() - t0, body: null, next: true })
    Promise.resolve(route.handler(req, res, next)).catch(reject)
  })
}

test('cold cache still paints the rows immediately', async () => {
  const first = await call('/github-watch/api/projects')
  assert.equal(first.code, 200)
  assert.ok(first.ms < 300, 'took ' + first.ms + ' ms; the account read is delaying the list again')
  assert.equal(first.body.projects.length, 2)
  assert.equal(first.body.plugins.length, 1)
  // `pending` is "not read yet", which is a different statement from "logged out"
  // and must not be rendered as "gh is missing".
  assert.equal(first.body.github.pending, true, 'a cold read must report pending')
})

test('the account endpoint answers before it has an answer', async () => {
  const gh = await call('/github-watch/api/github')
  assert.equal(gh.code, 200)
  assert.equal(gh.body.pending, true)
  assert.ok(gh.ms < 300, 'took ' + gh.ms + ' ms')
})

test('the background read resolves and is then served from cache', async () => {
  let got = null
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 150))
    got = await call('/github-watch/api/github')
    if (got.body && got.body.pending === false) break
  }
  assert.ok(got, 'the account endpoint never answered')
  assert.equal(got.body.pending, false, 'the background read never completed')
  // Either gh answered (loggedIn) or it is not installed (available:false with a
  // reason). Both are honest outcomes; silence is not.
  assert.ok(
    got.body.loggedIn === true || got.body.available === false || Boolean(got.body.error),
    'an unpending answer must say either who is logged in or why nobody is: ' + JSON.stringify(got.body),
  )
  assert.ok(got.ms < 60, 'a memoized answer took ' + got.ms + ' ms')

  const warm = await call('/github-watch/api/projects')
  assert.ok(warm.ms < 300, 'warm snapshot took ' + warm.ms + ' ms')
  assert.equal(warm.body.github.pending, false)
})

test('routing', async () => {
  const nope = await call('/github-watch/api/nope')
  assert.equal(nope.code, 404)
  assert.equal(nope.body.error, 'unknown endpoint')

  const other = await call('/somewhere-else')
  assert.equal(other.next, true, 'a foreign path must fall through to the next route')
})

test('the snapshot is shaped the way the page reads it', async () => {
  const got = await call('/github-watch/api/projects')
  const b = got.body
  assert.equal(b.ok, true)
  assert.equal(b.scannedAt, INVENTORY.scanned_at)
  assert.equal(b.generatedAt, '2026-10-31 18:00')
  assert.deepEqual(b.counts, { updated: 0, current: 2, failed: 0 })
  const bun = b.projects.find((p) => p.name === 'bun')
  assert.equal(bun.status, '最新')
  assert.equal(bun.version, '1.4.4')
  assert.equal(bun.path, 'C:/fake/bun')
})
