// Tests for the "is the installed copy the published one" comparison.
//
// The reason this exists: a package installed from a local tarball or a `link:`
// checkout can be hand-edited while its version string still matches the
// registry exactly. Every version-based check then says "up to date", which is
// true about the version and false about the code. `dsh-xdpool` is the real case
// — two edits, both marked `[xdpool-patch:*]`, version 2.6.4 either way.
//
// Nothing here touches the network: the tarballs are built in memory, and the
// comparison is a pure function of two file maps. The HTTP helpers are covered
// only at their failure edge (`fetchTarball` refusing an oversized body), since
// everything above that is `fetch`'s behaviour, not ours.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'

import { walkFingerprint, tarFingerprint, compareFingerprints, fetchTarball } from '../lib/patch.mjs'

/**
 * Build a gzipped ustar archive.
 *
 * `files` maps a path to its content. Paths longer than 100 bytes go through a
 * GNU `L` longname header, because the interesting npm packages have paths deep
 * enough to need one and a reader that only handles short names would pass a
 * naive test and fail in the field.
 */
function makeTgz(files) {
  const blocks = []
  const push = (buf) => blocks.push(buf)
  const pad = (n) => (n % 512 === 0 ? 0 : 512 - (n % 512))

  const header = (name, size, type = '0') => {
    const h = Buffer.alloc(512, 0)
    h.write(name.slice(0, 100), 0, 'utf8')
    h.write('0000644\0', 100, 'utf8')
    h.write('0000000\0', 108, 'utf8')
    h.write('0000000\0', 116, 'utf8')
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
    h.write('00000000000\0', 136, 'utf8')
    h.write(type, 156, 'utf8')
    h.write('ustar\0', 257, 'utf8')
    h.write('00', 263, 'utf8')
    // The checksum is computed with its own field read as spaces.
    h.write('        ', 148, 'utf8')
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    return h
  }

  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8')
    const long = Buffer.byteLength(path) > 100
    if (long) {
      const nm = Buffer.from(path + '\0', 'utf8')
      push(header('././@LongLink', nm.length, 'L'))
      push(nm)
      push(Buffer.alloc(pad(nm.length), 0))
    }
    push(header(long ? path.slice(0, 100) : path, data.length))
    push(data)
    push(Buffer.alloc(pad(data.length), 0))
  }
  push(Buffer.alloc(1024, 0)) // two zero blocks end the archive
  return gzipSync(Buffer.concat(blocks))
}

/** A temp dir with the given files, plus the paths that created it. */
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-patch-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the walk skips what an installer creates and the artifact never had', () => {
  const box = tree({
    'lib/index.js': 'module.exports = 1\n',
    'node_modules/dep/index.js': 'nested dependency\n',
    '.bin/launcher': '#!/bin/sh\n',
    '.git/config': '[remote]\n',
  })
  try {
    const fp = walkFingerprint(box.dir)
    assert.deepEqual([...fp.keys()].sort(), ['lib/index.js'])
  } finally {
    box.cleanup()
  }
})

test('a tarball reads back as the same paths the walk produces', () => {
  const files = { 'package/lib/index.js': 'module.exports = 1\n', 'package/package.json': '{}\n' }
  const tgz = makeTgz(files)
  const fp = tarFingerprint(tgz)
  assert.deepEqual([...fp.keys()].sort(), ['lib/index.js', 'package.json'])
})

test('a path too long for the fixed header survives the GNU long-name record', () => {
  const deep = `package/${'d'.repeat(60)}/${'n'.repeat(60)}/index.js`
  assert.ok(deep.length > 100, 'the fixture has to actually be too long')
  const fp = tarFingerprint(makeTgz({ [deep]: 'x\n' }))
  assert.deepEqual([...fp.keys()], [deep.replace(/^package\//, '')])
})

test('identical trees are not patched', () => {
  const box = tree({ 'lib/index.js': 'export const a = 1\n', 'package.json': '{}\n' })
  try {
    const local = walkFingerprint(box.dir)
    const published = tarFingerprint(makeTgz({ 'package/lib/index.js': 'export const a = 1\n', 'package/package.json': '{}\n' }))
    const cmp = compareFingerprints(local, published)
    assert.deepEqual(cmp.differing, [])
    assert.equal(cmp.patched, false)
  } finally {
    box.cleanup()
  }
})

test('one edited file marks the install patched and names it', () => {
  const box = tree({ 'lib/index.js': 'export const a = 1 // [patch]\n', 'package.json': '{}\n' })
  try {
    const local = walkFingerprint(box.dir)
    const published = tarFingerprint(makeTgz({ 'package/lib/index.js': 'export const a = 1\n', 'package/package.json': '{}\n' }))
    const cmp = compareFingerprints(local, published)
    assert.deepEqual(cmp.differing, ['lib/index.js'])
    assert.equal(cmp.patched, true)
  } finally {
    box.cleanup()
  }
})

test('a file only the install has is reported but does not by itself mean patched', () => {
  // A build step or the package manager can leave files behind. Calling that a
  // hand edit would make ordinary installs look tampered with.
  const box = tree({ 'lib/index.js': 'x\n', 'lib/index.js.map': '{"version":3}\n' })
  try {
    const local = walkFingerprint(box.dir)
    const published = tarFingerprint(makeTgz({ 'package/lib/index.js': 'x\n' }))
    const cmp = compareFingerprints(local, published)
    assert.deepEqual(cmp.differing, [])
    assert.deepEqual(cmp.onlyLocal, ['lib/index.js.map'])
    assert.equal(cmp.patched, false)
  } finally {
    box.cleanup()
  }
})

test('a file only the tarball has is reported, and is not a local edit', () => {
  const box = tree({ 'lib/index.js': 'x\n' })
  try {
    const local = walkFingerprint(box.dir)
    const published = tarFingerprint(makeTgz({ 'package/lib/index.js': 'x\n', 'package/README.md': '# hi\n' }))
    const cmp = compareFingerprints(local, published)
    assert.deepEqual(cmp.onlyPublished, ['README.md'])
    assert.equal(cmp.patched, false)
  } finally {
    box.cleanup()
  }
})

test('a body larger than the cap is refused rather than read into memory', async () => {
  // The cap exists because twenty-odd rows are compared per scan; one package at
  // 45 MB (billion-context is) would otherwise be downloaded for every one of them.
  // A data: URL sends no content-length, so this exercises the post-read check
  // — the header check is a courtesy, this one is the guarantee.
  const body = Buffer.alloc(4096, 7)
  const res = await fetchTarball('data:application/octet-stream;base64,' + body.toString('base64'), { maxBytes: 1024 })
  assert.equal(res.ok, false)
  assert.match(res.error, /超过上限/)
  assert.ok(!res.buf, 'a refused body must not be handed back')
})
