/**
 * Inventory every project currently on this machine, split into projects vs plugins.
 *
 * The question is "what is on disk now", not "what did I clone". A repo arrives by
 * clone, by zip download, by Release asset, or by an installer — only the first
 * leaves a trace in a shell transcript. So this walks the disk first and classifies
 * afterwards, instead of starting from command history.
 *
 * Two buckets:
 *   project — source you obtained and keep: a git repo, or a directory that looks
 *             like a checkout (has README/package.json/pyproject and its own dir)
 *   plugin  — a package installed *into* a host (DSH profile node_modules, or a
 *             directory whose manifest declares a dsh bundle/plugin)
 *
 * Excluded on purpose: another tool's cache (Codex plugins/cache, vendor_imports,
 * marketplaces) — those are not things the operator obtained.
 */
import { readFileSync, writeFileSync, readdirSync, lstatSync, statSync } from 'node:fs'
import { join, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureWatchDir,
  roots as configRoots,
  profileNodeModules,
  appdata,
  localappdata,
  isdir,
  isfile,
} from './config.mjs'

// ensure* rather than watchDir: on a clean install the directory does not exist
// yet, and this step's last line writes into it.
const WATCH = ensureWatchDir()
const OUT = join(WATCH, 'local_inventory.json')

const PROFILE_NM = profileNodeModules()

const ROOTS = configRoots()

const PRUNE = new Set([
  'node_modules', '.git', '__pycache__', 'AppData', '.cache', '.codex',
  '.trae-cn', '.workbuddy', '.codebuddy', '.claude', '.qoder', 'dist',
  'build', 'target', '.venv', 'venv', '__snapshots__',
])

// A directory counts as a project root only if it is one of:
//   * a git checkout (has .git)
//   * a top-level folder under a root that carries its own manifest AND source
// The earlier test — "has README.md or package.json" — turned Ghidra's 40 feature
// submodules into 40 projects, because each ships a build.gradle and a README.
// A submodule of a project is not a project.
const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'pom.xml', 'setup.py', 'build.gradle', 'SKILL.md',
]
const SOURCE_DIRS = ['src', 'lib', 'app', 'scripts', 'packages', 'bin']

const GH_REMOTE = /url\s*=\s*\S*github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/gm

const CACHE_MARKERS = [
  '\\plugins\\cache\\', '\\vendor_imports\\', '\\marketplaces\\',
  '\\connectors-marketplace\\',
]

// A downloaded release binary has neither `.git` nor a manifest, so nothing on
// disk says where it came from or what a newer version would be. SOURCE_MANIFEST
// is that missing record: a small JSON file written next to the binary at install
// time. Reading it is what lets the scanner track a program it cannot inspect.
const SOURCE_MANIFEST = '.dsh-source.json'

/** The install record for a hand-downloaded program, or {} if absent. */
function sourceManifest(path) {
  const fp = join(path, SOURCE_MANIFEST)
  if (!isfile(fp)) return {}
  try {
    const d = JSON.parse(readFileSync(fp, 'utf8'))
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {}
  } catch {
    return {}
  }
}

// Directories people conventionally keep checkouts in. Depth costs nothing to
// ignore here because a walk stops at the first `.git` it meets, so a deep
// `~/code/...` tree costs the same as a shallow one.
const PROJECT_PARENTS = new Set([
  'projects', 'project', 'repos', 'repositories', 'repo', 'src', 'source',
  'code', 'dev', 'develop', 'git', 'github', 'gitlab', 'checkouts', 'checkout',
  'workspace', 'workspaces', 'work', 'ai', 'tools', 'plugins', 'skills',
  'agents', 'sandbox', 'playground', 'experiments',
])

// Cost guards. A walk that trips either one returns what it found so far, so a
// user who points this at a whole drive gets a partial answer instead of a hang.
const MAX_DIRS = 60000
const MAX_SECONDS = 45.0

/**
 * How deep to keep walking from here. null means "no limit".
 *
 * The default depth is a fallback for ordinary folders; a conventional project
 * parent is allowed to run deep because the `.git` stop makes depth the wrong
 * thing to bound.
 */
function depthBudget(dirname, dflt) {
  if (PROJECT_PARENTS.has(String(dirname).toLowerCase())) return null
  return dflt
}

function readTextSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function gitRemote(path) {
  const cfg = join(path, '.git', 'config')
  if (!isfile(cfg)) return ''
  const text = readTextSafe(cfg)
  GH_REMOTE.lastIndex = 0
  const m = GH_REMOTE.exec(text)
  return m ? m[1] : ''
}

function repoSlugFromUrl(url) {
  const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(String(url).trim())
  return m ? m[1] : ''
}

/** name/description/version from package.json or pyproject, if present. */
function manifestInfo(path) {
  const pj = join(path, 'package.json')
  if (isfile(pj)) {
    try {
      const d = JSON.parse(readTextSafe(pj))
      const repo = d.repository
      const url = typeof repo === 'string' ? repo : (repo || {}).url || ''
      const dsh = d.dsh || {}
      return {
        name: d.name || '',
        version: d.version || '',
        description: String(d.description || '').slice(0, 200),
        repo: repoSlugFromUrl(url),
        is_dsh_plugin: Boolean(dsh.bundle || dsh.client),
      }
    } catch {
      /* unparseable manifest: fall through to pyproject */
    }
  }
  const py = join(path, 'pyproject.toml')
  if (isfile(py)) {
    const text = readTextSafe(py)
    const pick = (key) => {
      const m = new RegExp(`^${key}\\s*=\\s*["']([^"']+)`, 'm').exec(text)
      return m ? m[1] : ''
    }
    return {
      name: pick('name'),
      version: pick('version'),
      description: pick('description').slice(0, 200),
      repo: '',
      is_dsh_plugin: false,
    }
  }
  return { name: '', version: '', description: '', repo: '', is_dsh_plugin: false }
}

function dirSizeMb(path, capFiles = 4000) {
  let total = 0
  let seen = 0
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
        if (e.name === '.git' || e.name === 'node_modules') continue
        stack.push(join(dir, e.name))
        continue
      }
      try {
        total += statSync(join(dir, e.name)).size
      } catch {
        /* vanished or unreadable: skip it, the size is advisory */
      }
      seen += 1
      if (seen >= capFiles) return round1(total / 1048576)
    }
  }
  return round1(total / 1048576)
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function countSep(p) {
  return (String(p).match(/[\\/]/g) || []).length
}

function walkProjects() {
  const found = []
  let visited = 0
  const started = Date.now()

  // A recursive descent rather than the flat list os.walk produced, but with the
  // same stop rules: a `return` here is what `dirnames[:] = []; continue` meant.
  const walk = (dir, maxDepth, base) => {
    visited += 1
    // Cost is bounded by work done, not by a depth the user has to guess: hitting
    // either limit returns what was found so far instead of hanging.
    if (visited > MAX_DIRS || (Date.now() - started) / 1000 > MAX_SECONDS) {
      return true // "budget exhausted" — propagate up and stop
    }
    const depth = countSep(dir) - base
    const low = dir.toLowerCase()

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    const dirnames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    const filenames = entries.filter((e) => !e.isDirectory()).map((e) => e.name)

    const hasGit = dirnames.includes('.git')
    // An installed release binary declares itself here. Without this the walk has
    // no way to tell it apart from an application folder, and it is exactly the
    // case the operator cares about: something downloaded on purpose, with a
    // known upstream.
    const srcMeta = sourceManifest(dir)
    if (Object.keys(srcMeta).length) {
      found.push({
        path: dir,
        has_git: false,
        remote: srcMeta.repository || '',
        name: srcMeta.name || basename(dir),
        version: String(srcMeta.version ?? ''),
        description: String(srcMeta.summary || '').slice(0, 200),
        installed_from: srcMeta.installed_from || '',
        release_source: srcMeta.source || '',
        is_dsh_plugin: false,
        depth,
      })
      return false // declared itself; do not descend
    }

    const marks = PROJECT_MARKERS.filter((m) => filenames.includes(m))

    // Qualify on git, or on a manifest *plus* a source directory: an installed
    // application carries manifests in every subdirectory, but only a project has
    // its own source tree beside them.
    const hasSource = SOURCE_DIRS.some((d) => dirnames.includes(d))
    const qualifies = hasGit || (marks.length > 0 && hasSource && depth <= 2)

    // A repository root is the answer: stop descending immediately so the depth
    // limit stops mattering. Without this, `depth 5` had to be guessed precisely
    // — one level too shallow silently dropped projects, and every level deeper
    // meant walking node_modules and .venv trees.
    if (hasGit) {
      if (!CACHE_MARKERS.some((c) => low.includes(c))) {
        found.push({
          path: dir,
          has_git: true,
          remote: gitRemote(dir),
          ...manifestInfo(dir),
          depth,
        })
      }
      return false
    }

    const budget = depthBudget(basename(dir), maxDepth)
    if (budget !== null && depth >= budget) return false

    const descend = dirnames.filter((d) => !PRUNE.has(d))

    if (qualifies && depth > 0 && !CACHE_MARKERS.some((c) => low.includes(c))) {
      found.push({
        path: dir,
        has_git: hasGit,
        remote: gitRemote(dir),
        ...manifestInfo(dir),
        depth,
      })
    }

    for (const d of descend) {
      if (walk(join(dir, d), maxDepth, base)) return true
    }
    return false
  }

  let exhausted = false
  for (const [root, maxDepth] of ROOTS) {
    if (!isdir(root)) continue
    const base = countSep(root.replace(/[\\/]+$/, ''))
    exhausted = walk(root, maxDepth, base)
    if (exhausted) break
  }
  if (exhausted) {
    console.log(`  (预算用尽: ${visited} 目录，先返回已找到的)`)
  }

  return outermost(found)
}

/**
 * Keep the outermost of any nested group: a repo's own subfolders that happen to
 * qualify are not separate projects.
 */
function outermost(found) {
  found.sort((a, b) => countSep(a.path) - countSep(b.path))
  const kept = []
  for (const p of found) {
    const low = p.path.toLowerCase()
    if (kept.some((k) => low.startsWith(k.path.toLowerCase() + sep))) continue
    kept.push(p)
  }
  return kept
}

function pluginPackages() {
  const out = []
  for (const nm of PROFILE_NM) {
    if (!isdir(nm)) continue
    let top
    try {
      top = readdirSync(nm)
    } catch {
      continue
    }
    const candidates = []
    for (const entry of top) {
      const full = join(nm, entry)
      if (entry.startsWith('@')) {
        let subs
        try {
          subs = readdirSync(full)
        } catch {
          continue
        }
        for (const sub of subs) candidates.push(join(full, sub))
      } else if (isdir(full)) {
        candidates.push(full)
      }
    }
    for (const c of candidates) {
      if (!isfile(join(c, 'package.json'))) continue
      let d
      try {
        d = JSON.parse(readTextSafe(join(c, 'package.json')))
      } catch {
        continue
      }
      const dsh = d.dsh || {}
      if (!(dsh.bundle || dsh.client)) continue
      const info = manifestInfo(c)
      const profileName = nm.replace(/[\\/]+$/, '').split(/[\\/]/)
      // `...\profiles\<name>\node_modules` → the profile's bare name. Derived
      // rather than spelled out, so a `web` profile reports as `web`.
      const owner = profileName[profileName.length - 2] || 'desktop'
      out.push({
        path: c,
        profile: owner,
        name: d.name || entry,
        version: d.version || '',
        description: String(d.description || '').slice(0, 200),
        repo: info.repo,
        link: isLink(c),
      })
    }
  }
  return out
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// Package-manager installs that live outside the scan roots. `uv tool`, `pipx`
// and `npm -g` all drop a directory under AppData/Local or AppData/Roaming, which
// the walk prunes on purpose — those trees are enormous and mostly cache. But the
// *installed tools* in them were obtained by the operator and deserve a row, so
// they are looked up directly at their known locations instead of by walking.
function toolDescription(path, manager, name) {
  if (manager === 'uv tool' || manager === 'pipx') {
    let site = join(path, 'Lib', 'site-packages')
    if (!isdir(site)) site = join(path, 'lib', 'python3', 'site-packages')
    if (isdir(site)) {
      let entries
      try {
        entries = readdirSync(site).sort()
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (!entry.endsWith('.dist-info')) continue
        const norm = (s) => s.replace(/-/g, '_').toLowerCase()
        if (!norm(entry).includes(norm(name))) continue
        const meta = join(site, entry, 'METADATA')
        if (!isfile(meta)) continue
        for (const line of readTextSafe(meta).split('\n')) {
          if (line.startsWith('Summary:')) return line.split(':').slice(1).join(':').trim()
        }
        break
      }
    }
  }
  const pj = join(path, 'package.json')
  if (isfile(pj)) {
    try {
      const d = JSON.parse(readTextSafe(pj))
      return String(d.description || '').trim()
    } catch {
      /* unreadable manifest */
    }
  }
  return ''
}

function toolInstalls() {
  const out = []
  const roaming = appdata()
  const local = localappdata()

  const add = (path, manager, name, version, repo) => {
    out.push({
      path,
      profile: manager,
      name,
      version,
      description: toolDescription(path, manager, name),
      repo,
      link: false,
      is_tool: true,
    })
  }

  // uv tool: <Roaming>/uv/tools/<name>/uv-receipt.toml names the package but
  // records neither version nor source, so the version comes from the venv's
  // dist-info.
  const uvRoot = join(roaming, 'uv', 'tools')
  if (isdir(uvRoot)) {
    for (const entry of readdirSync(uvRoot).sort()) {
      const full = join(uvRoot, entry)
      const receipt = join(full, 'uv-receipt.toml')
      if (!isfile(receipt)) continue
      let name = entry
      let repo = ''
      const text = readTextSafe(receipt)
      const nm = /name\s*=\s*"([^"]+)"/.exec(text)
      if (nm) name = nm[1]
      const rm = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?["\s]/.exec(text)
      if (rm) repo = rm[1]

      // Version lives next to the installed package, not in the receipt.
      let version = ''
      const site = join(full, 'Lib', 'site-packages')
      if (isdir(site)) {
        let dists
        try {
          dists = readdirSync(site).sort()
        } catch {
          dists = []
        }
        for (const dist of dists) {
          if (!dist.endsWith('.dist-info')) continue
          const stem = dist.slice(0, -'.dist-info'.length)
          const cut = stem.lastIndexOf('-')
          const pkg = cut >= 0 ? stem.slice(0, cut) : stem
          const ver = cut >= 0 ? stem.slice(cut + 1) : ''
          if (pkg.replace(/_/g, '-').toLowerCase() === name.replace(/_/g, '-').toLowerCase()) {
            version = ver
            break
          }
        }
      }
      add(full, 'uv tool', name, version, repo)
    }
  }

  // pipx: <Local>/pipx/venvs/<name>/  — the version is in the dist-info dir.
  const pipxRoot = join(local, 'pipx', 'venvs')
  if (isdir(pipxRoot)) {
    for (const entry of readdirSync(pipxRoot).sort()) {
      const full = join(pipxRoot, entry)
      const site = join(full, 'Lib', 'site-packages')
      let version = ''
      let repo = ''
      if (isdir(site)) {
        const dists = readdirSync(site).sort()
        for (const dist of dists) {
          if (!dist.endsWith('.dist-info')) continue
          const stem = dist.slice(0, -'.dist-info'.length)
          if (stem.includes('-')) version = stem.slice(stem.lastIndexOf('-') + 1)
          const meta = join(site, dist, 'METADATA')
          const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m.exec(readTextSafe(meta))
          if (m) repo = m[1]
          break
        }
      }
      add(full, 'pipx', entry, version, repo)
    }
  }

  // npm -g: <Roaming>/npm/node_modules/<pkg>/
  const npmRoot = join(roaming, 'npm', 'node_modules')
  if (isdir(npmRoot)) {
    const cands = []
    for (const entry of readdirSync(npmRoot).sort()) {
      const full = join(npmRoot, entry)
      if (entry.startsWith('@')) {
        let subs
        try {
          subs = readdirSync(full).sort()
        } catch {
          continue
        }
        for (const sub of subs) cands.push(join(full, sub))
      } else if (isdir(full)) {
        cands.push(full)
      }
    }

    // A globally installed package often ships a platform binary as its own
    // scoped package (bun + @oven/bun-windows-x64). Both are real directories,
    // but only one of them is the thing the operator installed; the other is its
    // payload and always carries the same version. Listing both makes the list
    // look like it has twice as much installed as it does.
    const entries = []
    for (const c of cands) {
      const pj = join(c, 'package.json')
      if (!isfile(pj)) continue
      let d
      try {
        d = JSON.parse(readTextSafe(pj))
      } catch {
        continue
      }
      const repo = d.repository
      const url = typeof repo === 'string' ? repo : (repo || {}).url || ''
      entries.push({
        path: c,
        name: d.name || basename(c),
        version: d.version || '',
        repo: repoSlugFromUrl(url),
      })
    }

    // Drop any package that another entry depends on. Read dependencies from each
    // candidate's manifest; a name that appears there is payload, not a separate
    // install.
    const required = new Set()
    for (const e of entries) {
      try {
        const d = JSON.parse(readTextSafe(join(e.path, 'package.json')))
        for (const key of ['dependencies', 'optionalDependencies']) {
          for (const k of Object.keys(d[key] || {})) required.add(k)
        }
      } catch {
        /* unreadable manifest */
      }
    }

    for (const e of entries) {
      if (required.has(e.name)) continue
      add(e.path, 'npm -g', e.name, e.version, e.repo)
    }
  }

  return out
}

/**
 * Does this directory contain anything besides `.git`?
 *
 * An earlier version required `size_mb > 0.05`, which silently dropped genuinely
 * small repos: a fresh clone of a README-only project measures 0.0 MB, and
 * dsh-skills is 0.1 MB because it is all markdown. The intent was "skip empty
 * stubs", so test emptiness directly instead of guessing from size.
 */
function hasContent(path) {
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.name === '.git') continue
    if (!e.isDirectory()) return true
    try {
      if (readdirSync(join(path, e.name)).length > 0) return true
    } catch {
      /* unreadable subdirectory: treat as empty */
    }
  }
  return false
}

function normcase(p) {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

function main() {
  console.log('扫描本地项目…')
  let projects = walkProjects()
  console.log(`  ${projects.length} 个候选目录`)

  const plugins = pluginPackages()
  console.log(`DSH 插件（profile node_modules 里声明 dsh.bundle/client 的）: ${plugins.length} 个`)

  const toolsFound = toolInstalls()
  console.log(`包管理器装的（uv tool / pipx / npm -g）: ${toolsFound.length} 个\n`)

  for (const p of projects) p.size_mb = dirSizeMb(p.path)

  // Reclassify. A directory whose own manifest declares dsh.bundle / dsh.client
  // IS a plugin, wherever it sits on disk: dsh-agent-autoforge lives in
  // Desktop\dsh as a working copy and was being counted as a project.
  // `_dsh_unpacked` is an unpacked copy of the app itself, not something
  // obtained; empty stubs are not projects either.
  const moved = []
  for (const p of projects) {
    if (p.is_dsh_plugin) {
      plugins.push({
        path: p.path,
        profile: 'local checkout',
        name: p.name || basename(p.path),
        version: p.version || '',
        description: p.description || '',
        repo: p.remote || p.repo || '',
        link: false,
      })
      moved.push(p.path)
    }
  }

  projects = projects.filter(
    (p) =>
      !p.is_dsh_plugin &&
      !p.path.toLowerCase().includes('_dsh_unpacked') &&
      hasContent(p.path),
  )
  if (moved.length) {
    console.log('从项目区移到插件区（manifest 声明了 dsh.bundle/client）：')
    for (const m of moved) console.log(`  ${m}`)
    console.log('')
  }

  // De-duplicate plugins by real path. Two DIFFERENT installs must both stay: a
  // local checkout and the linked copy under the profile's node_modules share the
  // same (name, version), so keying on that pair silently dropped the checkout.
  // The path is what actually distinguishes an install.
  const seen = new Set()
  const uniq = []
  const sortedPlugins = [...plugins].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    if (a.profile !== b.profile) return a.profile < b.profile ? -1 : 1
    const ap = a.path.toLowerCase()
    const bp = b.path.toLowerCase()
    if (ap !== bp) return ap < bp ? -1 : 1
    return 0
  })
  for (const p of sortedPlugins) {
    const key = normcase(p.path)
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(p)
  }

  const data = { projects, plugins: uniq.concat(toolsFound) }
  writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8')

  const line = '='.repeat(100)
  console.log(line)
  console.log('项目区')
  console.log(line)
  for (const p of [...projects].sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1))) {
    const tag = p.has_git ? 'git' : 'dir'
    console.log(`${tag.padEnd(4)} ${p.path}`)
    console.log(`     ${(p.remote || '-').padEnd(40)} ${String(p.size_mb.toFixed(1)).padStart(8)} MB  ${(p.description || '').slice(0, 48)}`)
  }

  console.log('')
  console.log(line)
  console.log('插件区')
  console.log(line)
  for (const p of [...uniq].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    console.log(
      `${String(p.name).padEnd(28)} ${String(p.version).padEnd(12)} ${(p.repo || '-').padEnd(36)} ${String(p.description || '').slice(0, 40)}`,
    )
  }

  console.log(`\n写入 ${OUT}`)
  return 0
}

// Runnable two ways, and the distinction matters. `node lib/inventory.mjs` runs
// it directly; `lib/run.mjs` imports it and calls main() itself so that one entry
// point owns the step order. Without the guard, importing this file from a test
// to reach its helpers would start a full disk scan as a side effect.
const SELF = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (SELF) process.exitCode = main()

export { main }
