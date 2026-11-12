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
  //
  // The view flag is the one exception, and it is keyed on its initial value
  // rather than an index: 'projects' is the only string state that starts with
  // that word, so adding or removing a state above it cannot silently point the
  // preset at the wrong slot the way a hard-coded index would.
  let n = 0
  let viewSeen = false
  return {
    createElement: (type, props, ...children) => {
      const built = {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((c) => c != null && c !== false),
      }
      // Function components get invoked here, the way React would. Without
      // this a panel delegated from another plugin renders as a bare node and
      // every assertion about its content silently passes on nothing.
      return typeof type === 'function' ? type(props || {}) : built
    },
    useState(init) {
      const i = n++
      const base = typeof init === 'function' ? init() : init
      if (i === 0 && presets.firstLoad !== undefined) return [presets.firstLoad, () => {}]
      // `justRemoved` is the sixth useState in Watch() and the only one that
      // starts as an empty object, so it is keyed on its slot with that order
      // spelled out here: data, error, busy, filter, expanded, justRemoved.
      // A state added above it would silently shift this, which is why the
      // comment names the neighbours instead of just the index.
      if (i === 5 && presets.justRemoved !== undefined) return [presets.justRemoved, () => {}]
      if (!viewSeen && base === 'projects' && presets.view !== undefined) {
        viewSeen = true
        return [presets.view, () => {}]
      }
      return [base, () => {}]
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

// The <style> text, which `text` and `classes` deliberately skip. Rules aimed at
// another plugin's DOM are only visible here, so hiding the host panel's title
// block needs a test that reads the stylesheet rather than the tree.
function styles(node, out = []) {
  if (node == null || node === false) return out
  if (Array.isArray(node)) { node.forEach((n) => styles(n, out)); return out }
  if (typeof node !== 'object') return out
  if (node.type === 'style') { out.push(String(node.children)); return out }
  styles(node.children, out)
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

// What is left of the old second view is the page it lived on: one list, one bar,
// and the button that says what it does.

test('renders: a patched install is drawn as its own state, not as plain current', async () => {
  // Real case behind this: dsh-xdpool reports version 2.6.4, the registry
  // publishes 2.6.4, and the files on disk carry two hand edits. Both "up to
  // date" and "different code" are true, and the colour has to say so — green
  // would hide the edits, red would claim a problem that does not exist.
  const tree = await render({
    firstLoad: loaded({
      projects: [
        { name: 'dsh-xdpool', kind: 'tags', version: '2.6.4', latest: 'v2.6.4', status: '有本地补丁', state: 'live', path: 'C:/d', slug: 'XDTrees/dsh-xdpool' },
        { name: 'plain', kind: 'npm', version: '1.0.0', latest: '1.0.0', status: '最新', state: 'live', path: 'C:/p' },
      ],
    }),
  })
  const cls = classes(tree).join(' ')
  assert.ok(/gw_status patched\b/.test(cls), 'the patched row kept the plain status class: ' + cls.slice(0, 300))
  assert.ok(/gw_status current\b/.test(cls), 'an ordinary up-to-date row lost its own class')
})

test('renders: an uninstalled row is not on the page after it is reopened', async () => {
  // Real case behind this: github-mcp-server was deleted from the settings page
  // on 2026-11-11 and its crossed-out row was still sitting at the bottom of the
  // list days later. An uninstall is a decision about the disk, and the list
  // describes the disk — once the page is closed, a row that says "已卸载" is
  // answering a question nobody asked, about something that is no longer there.
  //
  // The row stays visible only while `justRemoved` holds its name, which is
  // session state set by a delete in this same page. A fresh page starts with
  // that map empty, and that is the state this test renders.
  const tree = await render({
    firstLoad: loaded({
      projects: [
        { name: 'still-here', kind: 'npm', version: '1.0.0', latest: '1.0.0', status: '最新', state: 'live', path: 'C:/a' },
        { name: 'gone-forever', kind: 'release', version: '2.0.3', status: '已卸载', state: 'removed', path: 'C:/b', slug: 'github/github-mcp-server' },
      ],
    }),
  })
  const t = text(tree)
  assert.ok(t.includes('still-here'), 'a live row disappeared: ' + t.slice(0, 200))
  assert.ok(!t.includes('gone-forever'), 'the uninstalled row is still on the page')
  // And not merely hidden by CSS: the row element itself must be gone, or the
  // tab counts and the list length would still include it.
  const cls = classes(tree).join(' ')
  assert.ok(!/isremoved/.test(cls), 'the uninstalled row is still rendered, only faded')
})

test('renders: a row deleted in this session stays on screen until the page closes', async () => {
  // The other half of the rule above. Dropping the row the instant the delete
  // returns would make a successful delete and a dead button look identical —
  // the operator clicks, the row disappears, and nothing says whether 25 MB
  // were actually released. So the name goes into `justRemoved`, and the row
  // survives with its crossed-out "已卸载" line and the freed size until the
  // page is closed, at which point the map is gone and the row with it.
  const tree = await render({
    firstLoad: loaded({
      projects: [
        { name: 'just-deleted', kind: 'release', version: '1.12.0', status: '已卸载', state: 'removed', path: 'C:/d', slug: 'github/github-mcp-server', sizeMb: 24.9 },
        { name: 'unrelated-old-delete', kind: 'npm', version: '1.0.0', status: '已卸载', state: 'removed', path: 'C:/e' },
      ],
    }),
    justRemoved: { 'just-deleted': true },
  })
  const t = text(tree)
  assert.ok(t.includes('just-deleted'), 'the row just deleted is not shown, so nothing confirms the delete')
  assert.ok(!t.includes('unrelated-old-delete'), 'a delete from an earlier session is still on the page')
  const cls = classes(tree).join(' ')
  assert.ok(/gw_row.*isremoved|isremoved/.test(cls), 'the row lost its crossed-out styling')
})

test('renders: the page carries one list, its bar, and the check-update button', async () => {
  const tree = await render({ firstLoad: loaded({ github: GH_OK }) })
  const cls = classes(tree).join(' ')
  const t = text(tree)
  assert.ok(/gw_row\b/.test(cls), 'the page drew no rows')
  assert.ok(/gw_bar\b/.test(cls), 'the filter and scan bar is gone')
  // The button does the same thing as the word the skills-manager panel uses for
  // its own button, so it says the same word. "扫描" described the disk walk,
  // which is only one of the three steps and the shortest one.
  assert.ok(t.includes('检查更新'), 'the scan button still calls itself something else')
  assert.ok(t.includes('本机 GitHub 项目'), 'the title does not name the page')
  // One list means no leftover second view: a kept container or row class would
  // render an empty box under the real one.
  assert.ok(!/gw_switch|gw_skList|gw_skRow|gw_hostPanel/.test(cls), 'markup from the removed view is still drawn')
})
