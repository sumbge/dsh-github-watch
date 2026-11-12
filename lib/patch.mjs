/**
 * Is the copy on disk the same thing the registry published?
 *
 * Every other check in this plugin answers a question about *versions*: npm says
 * 2.6.4, the repo's newest tag says v2.6.4, the local package.json says 2.6.4, so
 * the row reads "up to date". None of that looks at a byte. A package installed
 * from a `file:` tarball or a `link:` checkout can carry hand edits that no
 * registry ever sees — the version string is identical and the install is
 * genuinely different — and the only honest way to notice is to compare the
 * installed tree against the artifact that was published for that same version.
 *
 * That comparison is what this module does. It needs no dependencies: a tarball
 * is gzip + a few hundred 512-byte headers, and Node ships both halves.
 *
 * Scope, stated plainly: this only works when the exact version on disk is also
 * published. A `github:` install of an unreleased commit, or a fork that bumpbed
 * its own version, has no published counterpart to diff against, and callers get
 * `checked: false` with a reason rather than a guess.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

/**
 * Paths an installer or a build creates, which are legitimately absent from the
 * published artifact. `.bin` holds the platform's launcher shims; `.pnpm` and
 * `node_modules` are the package manager's own bookkeeping.
 */
const NOISE = /(^|\/)(\.bin|node_modules|\.git|\.pnpm|\.cache)(\/|$)/

/** sha256 of every file under `root`, keyed by forward-slash relative path. */
export function walkFingerprint(root) {
  const out = new Map()
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory: treated as absent, not as a difference
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      const rel = relative(root, p).split(sep).join('/')
      if (NOISE.test(rel)) continue
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        try {
          out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'))
        } catch {
          /* a file that vanished mid-walk is not a fact about the artifact */
        }
      }
    }
  }
  return out
}

/**
 * The same map, read out of a published `.tgz`.
 *
 * Hand-rolled on purpose: a tarball from npm is either ustar with a `package/`
 * prefix or carries GNU/pax long names for deep paths, and both forms appear in
 * the wild. A ~60-line reader is smaller than the dependency it would replace and
 * can be read in one sitting, which matters for code that decides what "up to
 * date" means.
 */
export function tarFingerprint(buf) {
  const tar = gunzipSync(buf)
  const out = new Map()
  let off = 0
  let longName = null
  let pax = null
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break // end-of-archive marker
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    const type = String.fromCharCode(h[156] || 48)
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const dataOff = off + 512
    const data = tar.subarray(dataOff, dataOff + size)
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '')
    } else if (type === 'x') {
      pax = data.toString('utf8')
    } else {
      let full = longName || (prefix ? `${prefix}/${name}` : name)
      longName = null
      if (pax) {
        // pax extended header: "LEN key=value\n", where a deep path can also be
        // split across a `path=` record.
        const m = pax.match(/(?:^|\n)\d+ path=([^\n]+)/)
        if (m) full = m[1]
        pax = null
      }
      // Only regular files carry content. Directories ("5"), symlinks ("2") and
      // the rest describe structure the walker re-derives from the tree itself.
      if (type === '0' || type === '\0' || type === '') {
        const rel = full.replace(/^package\//, '')
        if (rel && !rel.endsWith('/')) out.set(rel, createHash('sha256').update(data).digest('hex'))
      }
    }
    off = dataOff + Math.ceil(size / 512) * 512
  }
  return out
}

/**
 * Compare two fingerprints.
 *
 * `differing` is the load-bearing list: same path, different bytes, which is a
 * hand edit with no other explanation. `onlyLocal` is reported but weighed more
 * lightly — a package manager or a build step can leave files behind, so it is
 * evidence rather than proof. Both are surfaced because "the install differs from
 * the artifact" is the fact the operator needs; the split is there so they can
 * judge whether it was them.
 */
export function compareFingerprints(local, published) {
  const differing = []
  const onlyLocal = []
  const onlyPublished = []
  for (const [k, v] of local) {
    if (!published.has(k)) onlyLocal.push(k)
    else if (published.get(k) !== v) differing.push(k)
  }
  for (const k of published.keys()) if (!local.has(k)) onlyPublished.push(k)
  differing.sort()
  onlyLocal.sort()
  onlyPublished.sort()
  return {
    differing,
    onlyLocal,
    onlyPublished,
    // Only a file that exists on both sides with different bytes is proof of an
    // edit. A file that exists only locally can also be a build output, so it is
    // reported but does not, on its own, get to call the install patched.
    patched: differing.length > 0,
  }
}

/** Download a published tarball, refusing anything larger than `maxBytes`. */
export async function fetchTarball(url, { maxBytes = 24 * 1024 * 1024, timeout = 60 } = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'dsh-github-watch/1.0', Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(timeout * 1000),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    // The header is a claim, so it is used to refuse early and the body is counted
    // anyway — an honest server sends it, and a dishonest one is exactly why the
    // second check exists.
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > maxBytes) return { ok: false, error: `包体积 ${(declared / 1048576).toFixed(1)} MB 超过上限` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) return { ok: false, error: `包体积 ${(buf.length / 1048576).toFixed(1)} MB 超过上限` }
    return { ok: true, buf }
  } catch (exc) {
    return { ok: false, error: `${exc.name || 'Error'}: ${exc.message || exc}` }
  }
}

/**
 * The manifest of one exact version, not of the package.
 *
 * `/<name>/<version>` is ~4 KB and carries `dist`, while `/<name>` is the whole
 * packument — 8 MB for billion-context, which is what tripped the response cap
 * elsewhere in this plugin. Asking for the version also answers "is this exact
 * version published at all", which is the question this module starts with.
 */
export async function fetchVersionManifest(name, version, { timeout = 30 } = {}) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/${version}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'dsh-github-watch/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout * 1000),
    })
    if (res.status === 404) return { ok: false, missing: true, error: '这个版本没有发布到 npm' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, manifest: await res.json() }
  } catch (exc) {
    return { ok: false, error: `${exc.name || 'Error'}: ${exc.message || exc}` }
  }
}
