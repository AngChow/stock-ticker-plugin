/**
 * Client 半区冒烟测试：在 Node 里用最小 mock 环境执行 client.js 的 factory 与 apply，
 * 验证注册逻辑、slot 选项、组件函数首次调用都不抛错（浏览器里跑不起来的主要风险点）。
 *
 * 用法：node --test tests/          （随引擎测试一起跑）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** 最小 React mock：足够跑组件函数体，不做真实渲染。 */
function makeReactMock() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useRef(value) { return { current: value } },
  }
}

/** 执行 client.js，返回它交给 __ModuleLoader__.load 的模块对象。 */
function loadClientModule() {
  let captured
  const windowMock = {
    __ModuleLoader__: { load(spec) { captured = spec } },
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'globalThis', source)
  run(windowMock, { ...globalThis, window: windowMock })
  assert.ok(captured, 'client.js 应调用 window.__ModuleLoader__.load')
  const react = makeReactMock()
  const mod = captured.factory(name => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  return { spec: captured, mod }
}

test('client.js 声明包名 id，并导出 apply', () => {
  const { spec, mod } = loadClientModule()
  assert.equal(spec.id, 'stock-ticker')
  assert.equal(typeof mod.apply, 'function')
})

test('client 插件必须声明 slots/locale 的 inject', () => {
  // Client 侧 Cordis 同样有 inject 门控：未声明就访问 ctx.slots 会抛
  // 'cannot get property "slots" without inject' → client entry 变 failed →
  // 宿主 renderer 的 boot 检查失败（整个 App 起不来）。此断言防止回归。
  const { mod } = loadClientModule()
  assert.ok(Array.isArray(mod.inject), 'client plugin 必须导出 inject 数组')
  assert.ok(mod.inject.includes('slots'), "inject 必须包含 'slots'")
  assert.ok(mod.inject.includes('locale'), "inject 必须包含 'locale'")
})

test('apply 注册 shell.overlay 与设置页两个槽位，且翻译可用', () => {
  const { mod } = loadClientModule()
  const slots = []
  const injections = []
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    locale: {
      register() { return () => {} },
      bind() {
        const zh = { 'meta.title': '自选行情' }
        return key => zh[key] ?? key
      },
    },
    slots: {
      inject(owner, factory) { injections.push([owner, factory]) },
      register(options, component) { slots.push({ options, component }); return () => {} },
    },
  }

  mod.apply(ctx)

  assert.deepEqual(injections.map(([owner]) => owner), ['shell.overlay', 'settings.plugins.tab'])
  for (const [, factory] of injections) factory()
  assert.equal(slots.length, 2)

  const bySlot = new Map(slots.map(entry => [entry.options.name, entry]))
  for (const name of ['shell.overlay', 'settings.plugins.tab']) {
    const entry = bySlot.get(name)
    assert.ok(entry, `缺少槽位 ${name}`)
    assert.equal(entry.options.id, 'stock-ticker')
    assert.equal(typeof entry.options.order, 'number')
    assert.equal(typeof entry.component, 'function')
    assert.equal(entry.options.label(), '自选行情', `${name} 的 label 应解析为中文标题`)
  }
})

test('两个槽位组件首次调用不抛错', () => {
  const { mod } = loadClientModule()
  const slots = []
  const ctx = {
    effect() {},
    locale: { register() { return () => {} }, bind() { return key => key } },
    slots: {
      inject(_owner, factory) { factory() },
      register(options, component) { slots.push({ options, component }) },
    },
  }
  mod.apply(ctx)
  for (const { options, component } of slots) {
    const element = component()
    assert.ok(element, `${options.name} 组件应返回元素`)
    // 模拟 React 调度一次函数组件体
    const rendered = element.type(element.props)
    assert.ok(rendered, `${options.name} 组件体应返回元素`)
  }
})