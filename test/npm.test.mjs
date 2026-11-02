/**
 * Reading the npm registry without asking for the whole history.
 *
 * `https://registry.npmjs.org/<pkg>` returns every published version as one
 * document. billion-context's is over 8 MB, which tripped the response cap added
 * in this same round and turned a working check into "检查失败". The fix is to ask
 * for `/latest`, which is just the newest version's manifest.
 *
 * These tests pin three things so that path cannot quietly regress:
 *   - the URL actually asks for one version, not the packument;
 *   - the repository field is read from the manifest that came back, with no
 *     second request;
 *   - the repository field is parsed for every shape npm allows.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolate } from './helpers.mjs'

const box = isolate('gw-npm-')

const check = await import('../lib/check.mjs')

// ── slugFromRepository ───────────────────────────────────────────────────
// npm documents `repository` as "string or {type, url}", and the url is
// whatever `git remote` printed: with or without `git+`, with or without `.git`,
// and occasionally the scp form `git@github.com:owner/name.git`.

const SHAPES = [
    ['plain url', 'https://github.com/ranxianglei/billion-context'],
    ['git+ prefix', 'git+https://github.com/ranxianglei/billion-context.git'],
    ['object form', { type: 'git', url: 'git+https://github.com/ranxianglei/billion-context.git' }],
    ['scp form', 'git@github.com:ranxianglei/billion-context.git'],
    ['http not https', 'http://github.com/ranxianglei/billion-context'],
    ['trailing slash', 'https://github.com/ranxianglei/billion-context/'],
]

for (const [label, repo] of SHAPES) {
    test(`slugFromRepository reads the ${label}`, () => {
        assert.equal(check.slugFromRepository(repo), 'ranxianglei/billion-context')
    })
}

test('slugFromRepository keeps scoped owner names', () => {
    assert.equal(
        check.slugFromRepository('git+https://github.com/xmanrui/dsh-im.git'),
        'xmanrui/dsh-im')
})

test('slugFromRepository returns nothing for a non-GitHub repository', () => {
    // A row with no slug falls back to "no upstream", which is a truthful state.
    // Inventing a GitHub slug from a GitLab URL would send a request to the wrong
    // place and report whatever it found as this package's upstream.
    for (const repo of [
        'https://gitlab.com/someone/project',
        'https://bitbucket.org/someone/project',
        'https://codeberg.org/someone/project',
    ]) {
        assert.equal(check.slugFromRepository(repo), '', repo)
    }
})

test('slugFromRepository tolerates an empty or missing field', () => {
    for (const repo of ['', null, undefined, {}, { url: '' }]) {
        assert.equal(check.slugFromRepository(repo), '')
    }
})

// ── probeNpm's URL shape ─────────────────────────────────────────────────
// The URL is built inside probeNpm and not exported, so it is read out of the
// source instead. A behavioural test would have to talk to the real registry,
// which is slow, flaky and rate limited; what actually needs pinning is that we
// do not go back to asking for the packument.

test('probeNpm asks the registry for one version, not the whole packument', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../lib/check.mjs', import.meta.url), 'utf8')
    const at = src.indexOf('async function probeNpm(name)')
    assert.ok(at > 0, 'probeNpm moved or was renamed -- update this test')

    // Slice to the next top-level section marker rather than a fixed length:
    // a character budget silently truncates the assertions below when the
    // function grows, and a truncated window reads as "the code stopped doing X".
    const end = src.indexOf('// \u2500\u2500 main flow', at)
    assert.ok(end > at, 'the main-flow marker moved -- update this test')
    const body = src.slice(at, end)
    const url = /const url = `([^`]+)`/.exec(body)
    assert.ok(url, 'probeNpm no longer builds a url constant')
    assert.match(url[1], /\/latest$/, 'probeNpm is asking for the packument again: ' + url[1])
    assert.doesNotMatch(url[1], /dist-tags/, 'the packument path survived')

    // The version and the repository both come from the one document that came
    // back; a second fetch for the same information is what made this slow.
    assert.match(body, /data\.version/, 'probeNpm stopped reading data.version')
    assert.match(body, /slugFromRepository\(data\.repository\)/,
        'probeNpm is not reading the repository off the same response')
    assert.doesNotMatch(body, /await npmRepoSlug/, 'probeNpm is fetching the packument again')
})

test('npmRepoSlug is gone, not merely unused', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../lib/check.mjs', import.meta.url), 'utf8')
    assert.equal(src.includes('npmRepoSlug'), false,
        'the full-packument helper is back -- it fetched 8 MB to read one field')
})
