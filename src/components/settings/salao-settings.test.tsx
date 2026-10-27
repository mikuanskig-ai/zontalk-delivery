// @vitest-environment jsdom
// Configurações > Salão montada de verdade: as quatro abas carregam sem
// quebrar, mostram o que o servidor devolve e mandam os pedidos certos.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { resolvePermissions } from '@/lib/salao/permissions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { SalaoSettings } from './salao-settings'

interface Call { method: string; path: string; body: unknown }
const calls: Call[] = []
let routes: Record<string, (body: unknown) => { status?: number; json: unknown }> = {}
let root: Root | null = null
let container: HTMLElement

beforeEach(() => {
  calls.length = 0
  document.body.innerHTML = ''
  routes = {
    '/admin/tables': () => ({ json: { tables: [
      { id: 't1', number: 1, name: null, area: 'Salão', is_active: true, has_open_tab: false, qr_token: 'a'.repeat(32) },
      { id: 't2', number: 2, name: 'Janela', area: 'Salão', is_active: false, has_open_tab: false, qr_token: 'b'.repeat(32) },
    ] } }),
    '/admin/staff': () => ({ json: { staff: [{ id: 's1', name: 'Carlos', role: 'garcom', is_active: true }, { id: 's2', name: 'Marta', role: 'caixa', is_active: true }] } }),
    '/admin/devices': () => ({ json: { devices: [{ id: 'd1', name: 'Celular do Carlos', created_at: '2026-10-20T10:00:00Z', last_seen_at: '2026-10-27T11:00:00Z' }], pending_codes: [] } }),
    '/admin/settings': () => ({ json: {
      settings: { service_fee_percent: 10, service_fee_default_on: true, require_open_cash: true },
      permissions: resolvePermissions({}),
      meta: { roles: ['garcom', 'caixa', 'gerente'], configurable_roles: ['garcom', 'caixa'], actions: [
        { key: 'close_tab', label: 'Fechar comanda' }, { key: 'cancel_item', label: 'Cancelar item lançado' }, { key: 'reopen_tab', label: 'Reabrir comanda' },
      ] },
      printing: { enabled: true, last_polled_at: new Date().toISOString(), last_polled_caixa_at: null },
    } }),
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const path = new URL(input, 'http://localhost').pathname.replace('/api/salao', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const handler = routes[`${method} ${path}`] ?? routes[path]
    if (!handler) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
    const out = handler(body)
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200 })
  }))
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  vi.unstubAllGlobals()
})

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  const errors: unknown[][] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a))
  await act(async () => {
    root = createRoot(container)
    root.render(React.createElement(SalaoSettings))
  })
  await flush()
  return { errors, restore: () => spy.mockRestore() }
}
const n = (s: string | null) => (s ?? '').replace(/\s+/g, ' ')
const text = () => n(container.textContent)
const tab = (label: string) => [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === label) as HTMLElement
async function click(el: Element | null | undefined) {
  if (!el) throw new Error('elemento não encontrado')
  await act(async () => { (el as HTMLElement).click() })
  await flush()
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Configurações > Salão', () => {
  it('abre nas mesas, lista as existentes e cria várias de uma vez', async () => {
    routes['POST /admin/tables'] = () => ({ status: 201, json: { created: 5 } })
    const { errors, restore } = await mount()
    expect(text()).toContain('Criar mesas')
    expect(container.querySelectorAll('li').length).toBe(2)
    expect(container.querySelector('a[href="/delivery/salao-qr"]')).not.toBeNull()

    const [count, start] = [...container.querySelectorAll('input[inputmode="numeric"]')] as HTMLInputElement[]
    await type(count, '5')
    await type(start, '20')
    await click([...container.querySelectorAll('button')].find((b) => b.textContent!.includes('Criar mesas')))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/admin/tables')?.body).toMatchObject({ count: 5, start: 20 })
    expect(errors).toEqual([])
    restore()
  })

  it('equipe: cadastra com função e PIN; o botão só liga com nome e PIN de 4+ números', async () => {
    routes['POST /admin/staff'] = () => ({ status: 201, json: { staff: { id: 's3' } } })
    const { errors, restore } = await mount()
    await click(tab('Equipe'))
    expect(text()).toContain('Carlos')
    expect(text()).toContain('Marta')
    const register = () => [...container.querySelectorAll('button')].find((b) => n(b.textContent).includes('Cadastrar') && !n(b.textContent).includes('funcionário')) as HTMLButtonElement
    expect(register().disabled).toBe(true)
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[]
    const name = inputs.find((i) => !i.inputMode && i.type === 'text' && !i.placeholder)!
    const pin = inputs.find((i) => i.maxLength === 6 && !i.placeholder)!
    await type(name, 'Júlia')
    await type(pin, '12ab34')
    expect(pin.value).toBe('1234') // só números
    expect(register().disabled).toBe(false)
    await click(register())
    expect(calls.find((c) => c.method === 'POST' && c.path === '/admin/staff')?.body).toEqual({ name: 'Júlia', role: 'garcom', pin: '1234' })
    expect(errors).toEqual([])
    restore()
  })

  it('aparelhos: lista os conectados e gera o código de pareamento', async () => {
    routes['POST /admin/devices'] = () => ({ status: 201, json: { code: '482913', expires_at: new Date(Date.now() + 600_000).toISOString(), device_name: 'x' } })
    const { errors, restore } = await mount()
    await click(tab('Aparelhos'))
    expect(text()).toContain('Celular do Carlos')
    expect(text()).toContain('/salao')
    await click([...container.querySelectorAll('button')].find((b) => b.textContent!.includes('Gerar código')))
    expect(text()).toContain('482913')
    expect(text()).toContain('só pode ser usado uma vez')
    expect(errors).toEqual([])
    restore()
  })

  it('regras: mostra a matriz de permissões, o aviso das impressoras e salva só o que o dono mexeu', async () => {
    routes['PUT /admin/settings'] = () => ({ json: {} })
    const { errors, restore } = await mount()
    await click(tab('Regras e permissões'))
    expect(text()).toContain('Quem pode o quê')
    expect(text()).toContain('Fechar comanda')
    expect(text()).toContain('Print Agent conectado')
    expect(text()).toContain('nenhum Print Agent com impressora de caixa apareceu')

    // garçom pode fechar comanda (marca a caixinha)
    const box = container.querySelector('input[aria-label="Garçom pode: Fechar comanda"]') as HTMLInputElement
    expect(box.checked).toBe(false)
    await click(box)
    // reabrir comanda é fixo do gerente: caixinhas desabilitadas
    expect((container.querySelector('input[aria-label="Caixa pode: Reabrir comanda"]') as HTMLInputElement).disabled).toBe(true)

    await click([...container.querySelectorAll('button')].find((b) => b.textContent!.includes('Salvar regras')))
    const body = calls.find((c) => c.method === 'PUT' && c.path === '/admin/settings')?.body as { service_fee_percent: number; permissions: { garcom: { close_tab: boolean } } }
    expect(body.service_fee_percent).toBe(10)
    expect(body.permissions.garcom.close_tab).toBe(true)
    expect(errors).toEqual([])
    restore()
  })

  it('taxa de serviço fora de 0–100 não é enviada', async () => {
    routes['PUT /admin/settings'] = () => ({ json: {} })
    const { restore } = await mount()
    await click(tab('Regras e permissões'))
    const fee = [...container.querySelectorAll('input[inputmode="decimal"]')][0] as HTMLInputElement
    await type(fee, '150')
    await click([...container.querySelectorAll('button')].find((b) => b.textContent!.includes('Salvar regras')))
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    restore()
  })
})
