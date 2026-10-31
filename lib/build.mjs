/**
 * Turn the scan into the registry the Settings page reads.
 *
 * The machine-specific version of this file carried a hand-written PROJECTS list
 * with every project's absolute path. That cannot ship: on another machine those
 * paths do not exist, and the page would be a list of dead links.
 *
 * So the rule here is the inverse — the scan decides what is listed, and the only
 * hand-maintained file is optional *overrides* (`registry.json`) used to add a
 * note, alias, dependency or work directory to a row the scan already found.
 *
 * Inputs:
 *   local_inventory.json   written by the inventory step
 *   registry.json          optional; {"notes": {...}, "deps": {...}, ...}
 *   queue.json             optional; downloads a session reported
 *   inventory.json         the previous build, read only for mute flags
 *
 * Output:
 *   inventory.json         read by the plugin
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchDir, ensureWatchDir, isdir, isfile, profileDir, profileName } from './config.mjs'
import { loadJson, writeJson, round1, isoLocal } from './util.mjs'

const WATCH = ensureWatchDir()
const SRC = join(WATCH, 'local_inventory.json')
const OUT = join(WATCH, 'inventory.json')
const OVERRIDES = join(WATCH, 'registry.json')

// The profile whose package.json records how each plugin was installed and which
// ones it declares.
const PROFILE = profileDir()

// Bare name of the profile (`desktop`), which is what the inventory step writes
// into each entry's "profile" field. Derived, not spelled out.
const PROFILE_NAME = profileName()

/**
 * Trim a project's own description to the row's hint budget.
 *
 * Same split as the release summary: a CJK glyph carries about twice the
 * information of a latin character, so 20 vs 30 fits the same slot without one
 * language reading as truncated and the other as verbose. Cut at a clause
 * boundary so it reads as a phrase.
 */
function shortBlurb(text, limitCjk = 20, limitLatin = 30) {
  let s = String(text || '').trim()
  if (!s) return ''
  s = s.replace(/\s+/g, ' ')
  const cjk = /[\u4e00-\u9fff]/.test(s)
  const limit = cjk ? limitCjk : limitLatin
  // Count code points, not UTF-16 units: an emoji in a description would
  // otherwise consume two characters and cut the sentence short.
  const chars = Array.from(s)
  if (chars.length <= limit) return s
  const windowText = chars.slice(0, limit + 10).join('')
  let cut = -1
  const seps = [
    ['。', 5], ['，', 7], ['；', 7], ['、', 7], ['：', 9],
    ['!', 9], ['.', 9], [',', 12], [';', 12], [':', 12],
    ['—', 16], [' ', 18],
  ]
  for (const [sep, floor] of seps) {
    const pos = windowText.lastIndexOf(sep, limit)
    if (pos > floor) {
      cut = pos
      break
    }
  }
  const out = cut > 0 ? windowText.slice(0, cut) : chars.slice(0, limit).join('')
  return out.replace(/^[ ，,。.；;：:\-—]+|[ ，,。.；;：:\-—]+$/g, '')
}

/**
 * Sort key for "which copy is newer".
 *
 * An empty or unparseable version yields a tuple that sorts BELOW any real
 * version, so a checkout with no version never displaces a released one.
 */
function versionKeyForSort(v) {
  const text = String(v || '').trim()
  if (!text) return [-1]
  const parts = text.split(/[.\-+]/).slice(0, 4)
  const out = parts.map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : 0))
  return out.length ? out : [-1]
}

/** Lexicographic compare of two numeric tuples. */
function compareKeys(a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? -1
    const y = b[i] ?? -1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Size of a directory in MB. Dependencies are counted only when asked. */
function dirMb(path, includeDeps = false) {
  let total = 0
  const stack = [path]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!includeDeps && (e.name === '.git' || e.name === 'node_modules')) continue
        stack.push(join(dir, e.name))
        continue
      }
      try {
        total += statSync(join(dir, e.name)).size
      } catch {
        /* vanished or unreadable: the size is advisory */
      }
    }
  }
  return round1(total / 1048576)
}

function main() {
  const scan = loadJson(SRC)
  if (!scan) {
    console.error(`缺少 ${SRC}，先跑 inventory 步骤`)
    return 2
  }

  const ov = loadJson(OVERRIDES, {}) || {}
  const notes = ov.notes || {}
  const aliases = ov.aliases || {}
  const deps = ov.deps || {}
  const works = ov.work || {}
  const mutedKeep = {}

  // Preserve mute flags from the previous build: muting is a decision, and the
  // scanner cannot derive it. Without this a rebuild silently un-mutes everything
  // the operator parked.
  const previous = loadJson(OUT, {}) || {}
  for (const row of [...(previous.projects || []), ...(previous.plugins || [])]) {
    if (row.muted && row.name) mutedKeep[row.name] = true
  }

  let names = ov.names || {}
  const skip = new Set(ov.skip || [])
  // Downloads a session reported. Folded straight into the normal lists: a
  // separate "pending" section makes the operator approve their own downloads,
  // which is a step with no answer in it. What the page shows is what is on
  // disk; `want` rides along as the note so the reason survives.
  const queuedRaw = loadJson(join(WATCH, 'queue.json'), []) || []
  // A path the operator named in registry.json is also the path they chose to
  // keep when a repo is cloned twice. Without this, dedupe picked whichever
  // clone the scan happened to return first — and the stale copy under Documents
  // shadowed the live one under Desktop.
  const preferred = new Set([
    ...Object.keys(names),
    ...Object.keys(ov.notes || {}),
    ...Object.keys(ov.deps || {}),
  ])

  // Lower sorts earlier. Named-by-operator beats shallow beats scan order.
  const keepRank = (p, idx) => [
    preferred.has(p.path) ? 0 : 1,
    p.depth || 99,
    idx,
  ]
  const rankLt = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i]
    }
    return false
  }

  // One row per upstream, not per clone: a second checkout of the same remote is
  // an alias, and listing it separately makes the same repo appear twice with two
  // different sizes. Which clone survives matters — the operator's registry.json
  // picks it when they named a path, otherwise the shallowest.
  const chosen = new Map()
  const scanProjects = scan.projects || []
  scanProjects.forEach((p, idx) => {
    const path = p.path || ''
    if (skip.has(path)) return
    const remote = String(p.remote || '').trim().toLowerCase()
    const key = remote || `path:${path}`
    const cand = chosen.get(key)
    if (!cand || rankLt(keepRank(p, idx), keepRank(cand.p, cand.idx))) {
      chosen.set(key, { idx, p })
    }
  })
  const winners = [...chosen.values()].sort((a, b) => a.idx - b.idx)

  const projects = []
  for (const { p } of winners) {
    const path = p.path || ''
    // The scan guesses a name from the directory; the operator may know better (a
    // repo cloned into `rea-agents/` is still "rea"). Overrides win, keyed by
    // path so a rename survives a rescan.
    const fallback = basename(String(path).replace(/[\\/]+$/, '')) || '?'

    // Three numbers, because the page answers three different questions:
    //   own_mb  — this project's own bytes on disk (node_modules included)
    //   deps_mb — the dependencies listed under it
    //   size_mb — own + deps, the total a reader sees first. Keeping it as the
    //             sum is what makes "rea 2.9 GB" honest: the project is 535 MB,
    //             and the toolchain it needs is another 2.4 GB.
    const depsList = deps[path] || []
    const own = isdir(path) ? dirMb(path, true) : (p.size_mb || 0)
    const depsMb = round1(depsList.reduce((acc, d) => acc + (d.size_mb || 0), 0))
    const work = works[path] ?? null
    let workMb = work ? round1(Number(work.size_mb || 0)) : 0
    if (work && !work.size_mb) {
      workMb = round1((work.items || []).reduce((acc, it) => acc + (it.size_mb || 0), 0))
    }

    const entry = {
      name: names[path] || p.name || fallback,
      kind: p.has_git ? 'git' : 'dir',
      slug: p.remote || '',
      path,
      exists: isdir(path),
      version: p.version || '',
      description: shortBlurb(p.description),
      // Only a hand-downloaded release binary carries this; it is the record that
      // makes such a program trackable even though it has no .git.
      installed_from: p.installed_from || '',
      size_mb: round1(own + depsMb),
      note: notes[path] ?? '',
      aliases_present: aliases[path] || [],
      deps: depsList,
      work,
      own_mb: own,
      deps_mb: depsMb,
      work_mb: workMb,
    }
    if (mutedKeep[entry.name]) entry.muted = true
    projects.push(entry)
  }

  // Reported downloads join the list here. A path already found by the scan is
  // skipped: the scan's row carries real sizes and probe data, and duplicating it
  // would just show the same thing twice.
  const have = new Set(projects.map((p) => String(p.path || '').toLowerCase()))
  for (const q of Array.isArray(queuedRaw) ? queuedRaw : []) {
    const path = String(q.path || '')
    if (!path || !isdir(path)) continue // gone from disk: nothing to display
    if (have.has(path.toLowerCase()) || skip.has(path)) continue
    have.add(path.toLowerCase())
    const own = dirMb(path, true)
    projects.push({
      name: names[path] || q.name || basename(path.replace(/[\\/]+$/, '')) || '?',
      kind: q.method || 'dir',
      slug: q.slug || '',
      path,
      exists: true,
      version: String(q.version || ''),
      installed_from: q.installed_from || '',
      size_mb: round1(own),
      own_mb: round1(own),
      deps_mb: 0.0,
      work_mb: 0.0,
      note: q.want || q.note || '',
      aliases_present: [],
      deps: [],
      work: null,
      from_queue: true,
    })
  }

  // Projects the scan cannot find: a Release tarball unpacked outside the scanned
  // roots, a repo whose layout does not look like a checkout. They are declared in
  // registry.json rather than inferred, because guessing whether a directory is a
  // project is how the scan ends up listing 40 build submodules.
  for (const extra of ov.extra_projects || []) {
    const path = extra.path || ''
    if (!path || skip.has(path)) continue
    const own = isdir(path) ? dirMb(path, true) : 0
    const depsList = deps[path] || []
    const depsMb = round1(depsList.reduce((acc, d) => acc + (d.size_mb || 0), 0))
    const entry = {
      name: extra.name || basename(path.replace(/[\\/]+$/, '')),
      kind: extra.kind || 'dir',
      slug: extra.slug || '',
      path,
      exists: isdir(path),
      version: extra.version || '',
      note: extra.note || notes[path] || '',
      aliases_present: aliases[path] || [],
      deps: depsList,
      work: works[path] ?? null,
      own_mb: own,
      deps_mb: depsMb,
      size_mb: round1(own + depsMb),
      work_mb: 0.0,
    }
    if (mutedKeep[entry.name]) entry.muted = true
    projects.push(entry)
  }

  // One row per plugin, not one row per directory. The same package is often on
  // disk several times — the profile's node_modules (the install actually in use),
  // a working checkout, a stray clone from some agent — and the copies drift in
  // version. A row per directory re-asks "which one is real?" for every duplicate,
  // so keep the newest and record the rest as copies on that row.
  //
  // The profile's dependency spec is the only record of HOW a package was
  // installed, and the checker needs it: `github:owner/repo#v1` and `link:...` are
  // not registry packages, so asking npm their latest version answers for some
  // unrelated same-named project and the row then claims "up to date" while the
  // local copy is actually ahead.
  let declared = {}
  try {
    const prof = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
    declared = { ...(prof.dependencies || {}), ...(prof.optionalDependencies || {}) }
  } catch {
    declared = {}
  }

  /** npm | github | link | file | unknown, from the profile's spec. */
  const installSourceFor = (name) => {
    const spec = String(declared[name] || '').trim()
    if (!spec) return 'npm'
    const low = spec.toLowerCase()
    for (const prefix of ['github:', 'gitlab:', 'bitbucket:', 'git+', 'git:']) {
      if (low.startsWith(prefix)) return 'github'
    }
    if (low.startsWith('link:')) return 'link'
    if (low.startsWith('file:')) return 'file'
    if (low.startsWith('workspace:')) return 'link'
    if (/^[\^~>=<*\d]/.test(spec) || ['latest', 'next', 'beta'].includes(spec)) return 'npm'
    return 'unknown'
  }

  const raw = []
  for (const p of scan.plugins || []) {
    raw.push({
      name: p.name || '',
      // The inventory step writes this as `repo`; reading `remote` here (the name
      // projects use) silently produced an empty slug for every plugin, so
      // dsh-mcp-manager and dsh-purge showed "no upstream" even though their
      // manifests name a repository.
      slug: p.repo || p.remote || '',
      version: p.version || '',
      install_path: p.path || '',
      profile: p.profile || '',
      installed: true,
      note: notes[p.path || ''] ?? '',
      install_source: installSourceFor(p.name || ''),
      description: shortBlurb(p.description),
    })
  }

  const grouped = new Map()
  for (const entry of raw) {
    if (!grouped.has(entry.name)) grouped.set(entry.name, [])
    grouped.get(entry.name).push(entry)
  }

  const plugins = []
  for (const [name, entries] of grouped) {
    const keyed = entries.map((e, idx) => ({ key: versionKeyForSort(e.version), idx, e }))
    let bestKey = keyed[0].key
    for (const k of keyed) {
      if (compareKeys(k.key, bestKey) > 0) bestKey = k.key
    }
    // Among equals, the profile install wins: that is the copy the host loads.
    // Compared against the live profile name rather than "desktop", so the tie
    // breaks the same way on any machine.
    let primary = keyed.find((k) => compareKeys(k.key, bestKey) === 0 && k.e.profile === PROFILE_NAME)
    if (!primary) primary = keyed.find((k) => compareKeys(k.key, bestKey) === 0)
    const copies = entries.filter((e) => e !== primary.e)
    const merged = { ...primary.e }
    if (copies.length) {
      merged.copies = copies
        .slice()
        .sort((a, b) => compareKeys(versionKeyForSort(b.version), versionKeyForSort(a.version)))
        .map((c) => ({ path: c.install_path, version: c.version, profile: c.profile }))
    }
    if (mutedKeep[merged.name]) merged.muted = true
    plugins.push(merged)
  }
  plugins.sort((a, b) => {
    const x = (a.name || '').toLowerCase()
    const y = (b.name || '').toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  })

  // Two sections, not three. The question this page answers is "what did I
  // download, and is there a newer one" — so the split is by WHAT a thing is, not
  // by which package manager happened to install it:
  //   plugin  — extends DSH, lives in a profile's node_modules
  //   project — everything else the operator obtained
  //
  // A plugin is what the PROFILE declares, not what the disk happens to contain.
  // A directory on the Desktop with a `dsh.bundle` field looks exactly like an
  // installed plugin to a filesystem walk, so a source checkout kept around after
  // uninstalling was listed as installed — the operator had removed it and the
  // page still showed it.
  //
  // The profile's own package.json is the authority: if the name is not in its
  // dependencies, nothing loads it, and it is a downloaded project.
  const declaredNames = new Set(Object.keys(declared))
  const dshPlugins = []
  const projectPackages = []
  for (const p of plugins) {
    const profile = p.profile || ''
    // `desktop` / `web` come from a profile's node_modules and are already
    // installed; a `local checkout` counts only when the profile links it.
    if (profile === 'desktop' || profile === 'web') dshPlugins.push(p)
    else if (declaredNames.has(p.name)) dshPlugins.push(p)
    else projectPackages.push(p)
  }

  // Every package-manager install becomes a project row. `updater` records how to
  // upgrade it, because "更新所选" has to dispatch: git pull for a checkout,
  // uv/npm for a package, and nothing at all for a local link.
  const UPDATER = { 'uv tool': 'uv', pipx: 'pipx', 'npm -g': 'npm' }
  for (const p of projectPackages) {
    const manager = String(p.profile || '').trim()
    const updater = UPDATER[manager] || 'none'
    projects.push({
      name: p.name || '',
      slug: p.slug || '',
      path: p.install_path || '',
      kind: updater !== 'none' ? updater : 'dir',
      version: p.version || '',
      source: manager,
      updater,
      size_mb: 0.0,
      own_mb: 0.0,
      deps_mb: 0.0,
      work_mb: 0.0,
      aliases_present: [],
      deps: [],
      note: p.note || '',
      description: shortBlurb(p.description),
    })
  }

  // Standalone binaries are not packages, so no scan finds them: they are
  // declared. Each is checked for existence and its version read from the file,
  // because the page's job is "what do I have", not "what is in node_modules".
  const tools = []
  for (const t of ov.tools || []) {
    const path = t.path || ''
    const exists = Boolean(path) && isfile(path)
    let sizeMb = 0.0
    if (exists) {
      try {
        sizeMb = round1(statSync(path).size / 1048576)
      } catch {
        sizeMb = 0.0
      }
    }
    tools.push({
      name: t.name ?? '',
      slug: t.slug ?? '',
      version: t.version ?? '',
      path,
      why: t.why ?? '',
      exists,
      size_mb: sizeMb,
    })
  }

  // Anything the scan found that neither a curated row nor an override mentions.
  // With no hand-written registry there is no "curated" baseline, so the honest
  // definition is: a project the operator has not annotated — i.e. one they may
  // not know about. That is the whole point of the section: it catches a download
  // nobody logged.
  const known = new Set([
    ...Object.keys(ov.names || {}),
    ...Object.keys(ov.notes || {}),
    ...Object.keys(ov.deps || {}),
  ])
  const listedPaths = new Set(projects.map((p) => p.path))
  const discovered = []
  for (const p of scan.projects || []) {
    const path = p.path || ''
    if (known.has(path) || skip.has(path) || listedPaths.has(path)) continue
    discovered.push({
      name: p.name || basename(String(path).replace(/[\\/]+$/, '')),
      slug: p.remote || '',
      path,
      kind: p.has_git ? 'git' : 'dir',
      sizeMb: p.size_mb ?? dirMb(path),
      description: String(p.description || '').slice(0, 160),
    })
  }

  const data = {
    projects,
    plugins: dshPlugins,
    tools,
    discovered,
    scanned_at: isoLocal(),
    generated_from: 'local_inventory.json',
  }
  writeJson(OUT, data)

  console.log(`项目 ${projects.length} 个，插件 ${dshPlugins.length} 个，工具 ${tools.length} 个 -> ${OUT}`)
  if (discovered.length) {
    console.log(`未标注 ${discovered.length} 个（在 registry.json 里加一条就进主列表）:`)
    for (const d of discovered.slice(0, 10)) {
      console.log(
        `  ${String(d.name).padEnd(28)} ${String(d.slug || '-').padEnd(32)}${String(d.sizeMb).padStart(8)} MB`,
      )
    }
  }
  // A deleted directory disappears from the page. It used to linger as "目录不见了"
  // so a deletion could not be mistaken for a broken check — but that is a question
  // about history, and this list answers "what do I have". History lives in
  // watched.json.
  for (const p of projects) {
    // `exists` is absent on rows the scan did not produce (package-manager
    // installs, queued downloads), and absent means present — not missing.
    if (p.exists === false) continue
    const origin = p.slug || p.source || p.kind || '-'
    console.log(
      `  ${String(p.name).padEnd(28)} ${String(p.kind || '?').padEnd(5)} ${String(origin).padEnd(34)}` +
        `${String(p.version || '').padStart(10)}${String(p.size_mb || 0).padStart(8)} MB`,
    )
  }
  return 0
}

// Runnable two ways. `node lib/build.mjs` runs it directly; `lib/run.mjs` imports
// it and calls main() itself so one entry point owns the step order. The guard is
// what lets a test import `shortBlurb` without rebuilding the inventory.
const SELF = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (SELF) process.exitCode = main()

export { main, shortBlurb, versionKeyForSort, compareKeys }
