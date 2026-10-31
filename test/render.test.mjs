/**
 * Headless render of client.js: proves the page builds a tree instead of throwing.
 *
 * This is the test that would have caught the white screen. `node --check` parsed
 * the file happily; the crash was a ReferenceError inside the component — a
 * variable that had been deleted while the JSX that read it stayed behind. Only
 * actually calling the component finds that.
 *
 * The plugin's component is React-shaped, so a minimal React stand-in is enough.
 * The one rule that matters: the factory destructures `useState` and friends ONCE
 * at load time, so every scenario must reuse the SAME React object and vary the
 * data through the presets object instead of swapping React.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'client.js')

function makeReact(presets) {
  // State is assigned by call order, not by initial value: `data` and `dialog`
  // both start as null, so keying on the initial value would put the snapshot
  // into the confirm dialog. `data` is the first useState in Watch().
  let n = 0
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c != null && c !== false),
    }),
    useState(init) {
      const i = n++
      const base = typeof init === 'function' ? init() : init
      return [i === 0 && presets.firstLoad !== undefined ? presets.firstLoad : base, () => {}]
    },
    useEffect() {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
  }
}

// Walk the element tree, skipping the <style> node — CSS text contains every
// class name, so a naive text search would always match.
function text(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (node.type === 'style') return ''
  return text(node.children)
}

function classes(node, out = []) {
  if (node == null || node === false) return out
  if (Array.isArray(node)) { node.forEach((n) => classes(n, out)); return out }
  if (typeof node !== 'object') return out
  if (node.type === 'style') return out
  if (node.props && node.props.className) out.push(String(node.props.className))
  classes(node.children, out)
  return out
}

async function render(presets) {
  const React = makeReact(presets)
  let mod
  const sandbox = {
    window: { __ModuleLoader__: { load: (m) => { mod = m } } },
    document: { createElement: () => ({}), head: { appendChild() {} } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: true, json: async () => presets.api || {} }),
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SRC, 'utf8'), sandbox)
  const plugin = mod.factory((id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  })
  let registered = null
  plugin.apply({
    effect(fn) { fn() },
    inject(_names, fn) { if (fn) fn() },
    // `bind` returning the key is what the plugin already guards against: it
    // falls back to its own zh dictionary when the locale service has nothing.
    locale: { register() {}, bind: () => (k) => k },
    slots: {
      inject(_name, fn) { if (fn) fn() },
      register: (_meta, comp) => { registered = comp },
    },
  })
  assert.ok(registered, 'slots.register was never called')
  return registered()
}

const baseProjects = [
  { name: 'github-mcp-server', kind: 'release', version: '2.0.3', latest: '2.0.3', status: 'current', state: 'live', path: 'C:/x', slug: 'github/github-mcp-server', sizeMb: 28.6 },
  { name: 'bun', kind: 'npm', version: '1.4.4', latest: '1.4.4', status: 'current', state: 'live', path: 'C:/y', slug: 'oven-sh/bun' },
]

function loaded(extra) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counts: { updated: 0 },
    projects: baseProjects,
    plugins: [{ name: 'dsh-github-watch', profile: 'desktop', version: '1.0.0', latest: '1.0.0', status: 'current', state: 'live', path: 'C:/z' }],
    ...extra,
  }
}

const GH_OK = {
  available: true,
  loggedIn: true,
  active: { login: 'sumbge', host: 'github.com', tokenSource: 'keyring', scopes: 'gist, read:org, repo' },
  rate: { remaining: 4992, limit: 5000 },
}

const scenarios = [
  ['signed in', { firstLoad: loaded({ github: GH_OK }) },
    { 'account card': true, 'shows login': true, 'shows quota': true, 'device panel': false }],
  ['no data yet', { firstLoad: loaded({}) },
    { 'account card': false, 'shows login': false }],
  ['login pending', {
    firstLoad: loaded({
      github: { available: true, loggedIn: false, login: { running: true, code: 'CC58-7FAA', url: 'https://github.com/login/device' } },
    }),
  }, { 'account card': true, 'device panel': true, 'shows code': true, 'shows quota': false }],
  ['gh missing', { firstLoad: loaded({ github: { available: false, reason: '没有找到 GitHub CLI' } }) },
    { 'account card': true, 'shows login': false }],
  ['quota low', {
    firstLoad: loaded({
      github: { available: true, loggedIn: true, active: { login: 'sumbge', host: 'github.com' }, rate: { remaining: 37, limit: 5000 } },
    }),
  }, { 'account card': true, 'shows quota': true, 'shows login': true }],
  // A cold cache reports `pending`, which is not "logged out". Rendering the card
  // then would claim gh is missing, so nothing is drawn until the read lands.
  ['account not read yet', { firstLoad: loaded({ github: { pending: true, login: { running: false } } }) },
    { 'account card': false, 'shows login': false, 'shows quota': false }],
]

for (const [label, presets, want] of scenarios) {
  test('renders: ' + label, async () => {
    const tree = await render(presets)
    const t = text(tree)
    const cls = classes(tree).join(' ')
    const checks = {
      'account card': /gw_gh\b/.test(cls),
      'device panel': /gw_dev\b/.test(cls),
      'shows login': t.includes('sumbge'),
      'shows quota': /4992|37 \//.test(t),
      'shows code': t.includes('CC58-7FAA'),
      // The stats bar was removed on request; a stale `stat(` call or a kept CSS
      // rule would be a silent regression back to a row nobody asked for.
      'no stats bar': !/gw_stats|gw_stat\b/.test(cls),
    }
    for (const [k, v] of Object.entries(want)) {
      assert.equal(checks[k], v, label + ': expected ' + k + '=' + v + ' — text: ' + t.slice(0, 200))
    }
    assert.ok(checks['no stats bar'], label + ': the stats bar came back')
  })
}
