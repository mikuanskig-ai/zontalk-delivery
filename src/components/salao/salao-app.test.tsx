// @vitest-environment jsdom
// Monta o app do salão de verdade (jsdom) contra um servidor de mentira.
// A regra desde o incidente de 23/10 (v0.40.1): nenhuma tela nova vai ao ar
// sem ser montada inteira num teste — captura de tela só do pedaço visual
// não pega um hook que quebra a página.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { resolvePermissions, type SalaoRole } from '@/lib/salao/permissions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'
import { SalaoApp } from './salao-app'

type Handler = (body: unknown, url: URL) => { status?: number; json: unknown }
interface Call { method: string; path: string; body: unknown }

const calls: Call[] = []
let routes: Record<string, Handler> = {}
let root: Root | null = null
let container: HTMLElement

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      const url = new URL(input, 'http://localhost')
      const path = url.pathname.replace('/api/salao', '')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ method, path, body })
      const handler = routes[`${method} ${path}`] ?? routes[path]
      if (!handler) return new Response(JSON.stringify({ error: 'not_found', message: `sem rota ${method} ${path}` }), { status: 404 })
      const out = handler(body, url)
      return new Response(JSON.stringify(out.json), { status: out.status ?? 200 })
    }),
  )
}

const me = (role: SalaoRole = 'garcom', over: Record<string, unknown> = {}) => ({
  state: 'ok',
  account: { name: 'Concórdia', currency: 'BRL', slug: 'c' },
  actor: { name: role === 'caixa' ? 'Marta' : 'Carlos', role, via: 'device' },
  permissions: resolvePermissions({})[role],
  settings: { service_fee_percent: 10, require_open_cash: true },
  cash_open: true,
  ...over,
})

const tab = (over: Record<string, unknown> = {}) => ({
  id: 'tab-1', table_id: 't12', label: 'Mesa 12', status: 'open', guests: 4, customer_name: null, opened_by_name: 'Ana',
  opened_at: new Date().toISOString(), bill_requested_at: null, closed_by_name: null, closed_at: null,
  service_fee_enabled: true, service_fee_percent: 10, discount_amount: 0, subtotal: 100, service_fee_amount: 10, total: 110, ...over,
})

const floor = () => ({
  tables: [
    { id: 't1', number: 1, name: null, area: 'Salão', status: 'free', tab: null },
    { id: 't12', number: 12, name: null, area: 'Salão', status: 'open', tab: { id: 'tab-1', total: 110, guests: 4, opened_at: new Date().toISOString(), opened_by_name: 'Ana', status: 'open', bill_requested_at: null } },
    { id: 't7', number: 7, name: null, area: 'Varanda', status: 'bill_requested', tab: { id: 'tab-7', total: 80, guests: 2, opened_at: new Date().toISOString(), opened_by_name: 'Ana', status: 'bill_requested', bill_requested_at: new Date().toISOString() } },
  ],
  counter_tabs: [{ id: 'tab-b1', label: 'Balcão 1', total: 25, opened_at: new Date().toISOString(), opened_by_name: 'Ana', status: 'open' }],
  cash: { id: 'c1', status: 'open', opening_float: 100, opened_by_name: 'Marta', opened_at: new Date().toISOString() },
  totals: { open_tabs: 3, open_total: 215 },
  server_time: new Date().toISOString(),
})

const detail = (tabOver: Record<string, unknown> = {}) => ({
  tab: tab(tabOver),
  rounds: [{ id: 'r1', number: 1, sent_by_name: 'Ana', created_at: new Date().toISOString() }],
  items: [
    { id: 'i1', round_id: 'r1', product_name: 'Marmita P', unit_price: 28, quantity: 2, addons_snapshot: [{ group_name: 'Carne', option_name: 'Churrasco' }], line_total: 56, notes: 'sem cebola', status: 'active', cancelled_reason: null, cancelled_by_name: null },
    { id: 'i2', round_id: 'r1', product_name: 'Suco', unit_price: 9, quantity: 1, addons_snapshot: [], line_total: 9, notes: null, status: 'cancelled', cancelled_reason: 'cliente desistiu', cancelled_by_name: 'Marta' },
  ],
  payments: [] as Record<string, unknown>[],
})

const menu = {
  categories: [
    { id: 'c1', name: 'Pratos', position: 0, products: [
      { id: 'p1', name: 'Marmita P', description: null, price: 28, image_url: null, position: 0, addon_groups: [] },
      { id: 'p2', name: 'Prato do dia', description: 'com acompanhamento', price: 40, image_url: null, position: 1, addon_groups: [
        { id: 'g1', name: 'Ponto da carne', selection_type: 'single', is_required: true, min_select: 1, max_select: 1, options: [{ id: 'o1', name: 'Ao ponto', price_delta: 0 }, { id: 'o2', name: 'Bem passado', price_delta: 0 }] },
      ] },
    ] },
  ],
  uncategorized: [],
  currency: 'BRL',
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  const errors: unknown[][] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a))
  await act(async () => {
    root = createRoot(container)
    root.render(React.createElement(SalaoApp))
  })
  await flush()
  return { errors, restore: () => spy.mockRestore() }
}

const n = (s: string | null) => (s ?? '').replace(/\s+/g, ' ')
const text = () => n(container.textContent)
const button = (label: string | RegExp) =>
  [...container.querySelectorAll('button')].find((b) => (typeof label === 'string' ? n(b.textContent).trim().includes(label) : label.test(n(b.textContent)))) as HTMLButtonElement | undefined
async function click(el: Element | undefined | null) {
  if (!el) throw new Error('elemento não encontrado')
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

beforeEach(() => {
  calls.length = 0
  routes = {}
  document.body.innerHTML = ''
  window.localStorage.clear()
  installFetch()
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe('acesso', () => {
  it('aparelho ainda não conectado: mostra o teclado do código de 6 números', async () => {
    routes['/me'] = () => ({ json: { state: 'device_required' } })
    const { errors, restore } = await mount()
    expect(errors).toEqual([])
    expect(text()).toContain('Conectar este celular')
    expect(button('Conectar')!.disabled).toBe(true)
    restore()
  })

  it('digitar o código certo conecta e recarrega o estado', async () => {
    let connected = false
    routes['/me'] = () => ({ json: connected ? { state: 'pin_required', account_name: 'Concórdia' } : { state: 'device_required' } })
    routes['POST /connect'] = () => {
      connected = true
      return { json: { ok: true } }
    }
    const { restore } = await mount()
    for (const d of ['1', '2', '3', '4', '5', '6']) await click(button(new RegExp(`^${d}$`)))
    expect(button('Conectar')!.disabled).toBe(false)
    await click(button('Conectar'))
    expect(calls.find((c) => c.path === '/connect')?.body).toEqual({ code: '123456' })
    expect(text()).toContain('Digite seu PIN')
    restore()
  })

  it('código errado mostra a mensagem do servidor e limpa o campo', async () => {
    routes['/me'] = () => ({ json: { state: 'device_required' } })
    routes['POST /connect'] = () => ({ status: 404, json: { error: 'invalid_code', message: 'Código inválido ou vencido. Peça um novo ao responsável.' } })
    const { restore } = await mount()
    for (const d of '123456') await click(button(new RegExp(`^${d}$`)))
    await click(button('Conectar'))
    expect(text()).toContain('Código inválido ou vencido')
    expect(button('Conectar')!.disabled).toBe(true)
    restore()
  })

  it('PIN certo entra no salão; PIN errado mostra o erro', async () => {
    let logged = false
    routes['/me'] = () => ({ json: logged ? me() : { state: 'pin_required', account_name: 'Concórdia' } })
    routes['/floor'] = () => ({ json: floor() })
    routes['POST /pin'] = (body) => {
      if ((body as { pin: string }).pin === '1111') {
        logged = true
        return { json: { ok: true } }
      }
      return { status: 401, json: { error: 'wrong_pin', message: 'PIN incorreto.' } }
    }
    const { restore } = await mount()
    expect(text()).toContain('Concórdia')
    for (const d of '9999') await click(button(new RegExp(`^${d}$`)))
    await click(button('Entrar'))
    expect(text()).toContain('PIN incorreto.')
    for (const d of '1111') await click(button(new RegExp(`^${d}$`)))
    await click(button('Entrar'))
    expect(text()).toContain('Mesas')
    expect(text()).toContain('Carlos')
    restore()
  })

  it('quando o servidor diz que a sessão acabou, volta sozinho para o PIN', async () => {
    let expired = false
    routes['/me'] = () => ({ json: expired ? { state: 'pin_required', account_name: 'Concórdia' } : me() })
    routes['/floor'] = () => (expired ? { status: 401, json: { error: 'pin_required', message: 'Digite seu PIN para continuar.' } } : { json: floor() })
    const { restore } = await mount()
    expect(text()).toContain('Mesas')
    expired = true
    await click(button('Mesas'))
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    // a próxima consulta do mapa recebe 401 e o app volta para o PIN
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush(6)
    expect(text()).toContain('Digite seu PIN')
    restore()
  })
})

describe('mapa do salão', () => {
  beforeEach(() => {
    routes['/me'] = () => ({ json: me() })
    routes['/floor'] = () => ({ json: floor() })
  })

  it('mostra as mesas por área, com o estado de cada uma, o resumo e o caixa', async () => {
    const { errors, restore } = await mount()
    expect(errors).toEqual([])
    const t = text()
    expect(t).toContain('Salão')
    expect(t).toContain('Varanda')
    expect(t).toContain('3 comandas abertas'.replace('3 ', '3').replace('3', '3')) // número e rótulo em elementos vizinhos
    expect(t).toContain('R$ 215,00')
    expect(t).toContain('Aberto') // caixa
    expect(t).toContain('Pediu a conta')
    expect(t).toContain('Balcão 1')
    restore()
  })

  it('mesa ocupada abre a comanda; mesa livre pergunta quantas pessoas e abre', async () => {
    routes['/tabs/tab-1'] = () => ({ json: detail() })
    routes['POST /tabs'] = (body) => ({ status: 201, json: { tab: tab({ id: 'tab-new', label: 'Mesa 1' }), existing: false, echo: body } })
    routes['/tabs/tab-new'] = () => ({ json: { tab: tab({ id: 'tab-new', label: 'Mesa 1', subtotal: 0, service_fee_amount: 0, total: 0 }), rounds: [], items: [], payments: [] } })
    const { errors, restore } = await mount()

    await click([...container.querySelectorAll('button')].find((b) => n(b.textContent).includes('12') && n(b.textContent).includes('R$ 110,00')))
    expect(text()).toContain('Mesa 12')
    expect(text()).toContain('Marmita P')

    // volta e abre a livre
    await act(async () => window.history.back())
    await flush()
    await click([...container.querySelectorAll('button')].find((b) => /Livre/.test(n(b.textContent)) && n(b.textContent).includes('1')))
    const dialogButton = (label: string) => [...document.querySelectorAll('button')].find((x) => n(x.textContent).includes(label)) ?? undefined
    expect(n(document.body.textContent)).toContain('Abrir mesa 1')
    await click(dialogButton('Mais uma pessoa') ?? document.querySelector('button[aria-label="Mais uma pessoa"]'))
    await click(dialogButton('Abrir comanda'))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/tabs')?.body).toEqual({ table_id: 't1', guests: 3 })
    expect(text()).toContain('Nenhum item ainda')
    expect(errors).toEqual([])
    restore()
  })
})

describe('comanda', () => {
  async function openTab12(role: SalaoRole, payload = detail()) {
    routes['/me'] = () => ({ json: me(role) })
    routes['/floor'] = () => ({ json: floor() })
    routes['/tabs/tab-1'] = () => ({ json: payload })
    const mounted = await mount()
    await click([...container.querySelectorAll('button')].find((b) => n(b.textContent).includes('12') && n(b.textContent).includes('R$ 110,00')))
    return mounted
  }

  it('mostra rodadas, itens, adicionais, observação, cancelados e totais', async () => {
    const { errors, restore } = await openTab12('caixa')
    const t = text()
    expect(t).toContain('Rodada 1')
    expect(t).toContain('2×')
    expect(t).toContain('Carne: Churrasco')
    expect(t).toContain('“sem cebola”')
    expect(t).toContain('Cancelado por Marta: cliente desistiu')
    expect(t).toContain('Taxa de serviço (10%)')
    expect(t).toContain('R$ 110,00')
    expect(t).toContain('R$ 27,50 por pessoa (4)')
    expect(errors).toEqual([])
    restore()
  })

  it('garçom NÃO vê o botão de fechar conta nem o de cancelar item; vê a explicação', async () => {
    const { restore } = await openTab12('garcom')
    expect(button('Fechar conta')).toBeUndefined()
    expect(container.querySelector('button[aria-label="Cancelar Marmita P"]')).toBeNull()
    expect(text()).toContain('O caixa fecha a conta.')
    expect(button('Adicionar itens')).toBeDefined()
    restore()
  })

  it('caixa vê fechar conta, cancelar item e desconto', async () => {
    const { restore } = await openTab12('caixa')
    expect(button('Fechar conta')).toBeDefined()
    expect(container.querySelector('button[aria-label="Cancelar Marmita P"]')).not.toBeNull()
    expect(button('Desconto')).toBeDefined()
    restore()
  })

  it('cancelar item exige motivo e avisa a cozinha', async () => {
    routes['POST /tabs/tab-1/items/i1/cancel'] = () => ({ json: { printed: true } })
    const { restore } = await openTab12('caixa')
    await click(container.querySelector('button[aria-label="Cancelar Marmita P"]'))
    const confirm = () => [...container.ownerDocument.querySelectorAll('button')].find((b) => n(b.textContent).includes('Cancelar item')) as HTMLButtonElement
    expect(confirm().disabled).toBe(true)
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Lançado errado'))
    expect(confirm().disabled).toBe(false)
    await click(confirm())
    expect(calls.find((c) => c.path === '/tabs/tab-1/items/i1/cancel')?.body).toEqual({ reason: 'Lançado errado' })
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining('A cozinha foi avisada'))
    restore()
  })

  it('pedir a conta imprime no caixa e avisa quando a impressão está desligada', async () => {
    routes['POST /tabs/tab-1/bill'] = () => ({ json: { printed: false, tab: tab() } })
    const { restore } = await openTab12('garcom')
    await click(button('Pedir a conta'))
    expect(calls.some((c) => c.path === '/tabs/tab-1/bill')).toBe(true)
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining('impressão está desligada'))
    restore()
  })

  it('fechar conta: soma de pagamentos tem que bater; dinheiro mostra o troco; envia os pagamentos', async () => {
    routes['POST /tabs/tab-1/close'] = () => ({ json: { tab_id: 'tab-1', total: 110, change: 10 } })
    const { restore } = await openTab12('caixa')
    await click(button('Fechar conta'))
    expect(n(document.body.textContent)).toContain('Falta receber R$ 110,00')
    const finish = () => [...document.querySelectorAll('button')].find((b) => n(b.textContent).includes('Concluir e fechar comanda')) as HTMLButtonElement
    expect(finish().disabled).toBe(true)

    // Pix 70 + dinheiro 40 (cliente entrega 50 → troco 10)
    const amount = document.querySelector('#pay-amount') as HTMLInputElement
    const setValue = async (el: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setValue(amount, '70')
    await click([...document.querySelectorAll('button')].find((b) => n(b.textContent).includes('Adicionar pagamento')))
    expect(n(document.body.textContent)).toContain('Falta receber R$ 40,00')
    await click([...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-pressed') !== null && n(b.textContent).includes('Dinheiro')))
    await setValue(document.querySelector('#pay-tendered') as HTMLInputElement, '50')
    expect(n(document.body.textContent)).toContain('Troco: R$ 10,00')
    await click([...document.querySelectorAll('button')].find((b) => n(b.textContent).includes('Adicionar pagamento')))
    expect(finish().disabled).toBe(false)
    await click(finish())

    expect(calls.find((c) => c.path === '/tabs/tab-1/close')?.body).toEqual({
      payments: [{ method: 'pix', amount: 70 }, { method: 'cash', amount: 40, tendered: 50 }],
    })
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringMatching(/Troco: R\$\s10,00/))
    restore()
  })

  it('comanda fechada: só leitura, mostra os pagamentos, e só o gerente reabre', async () => {
    const closed = { ...detail({ status: 'closed', closed_by_name: 'Marta', closed_at: new Date().toISOString() }), payments: [{ id: 'p1', method: 'pix', amount: 110, tendered: null, change_amount: 0, received_by_name: 'Marta' }] }
    const caixa = await openTab12('caixa', closed)
    expect(text()).toContain('Fechada')
    expect(text()).toContain('Pix')
    expect(button('Reabrir')).toBeUndefined()
    expect(button('Adicionar itens')).toBeUndefined()
    caixa.restore()

    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    calls.length = 0
    const gerente = await openTab12('gerente', closed)
    expect(button('Reabrir')).toBeDefined()
    gerente.restore()
  })
})

describe('adicionar itens', () => {
  async function openAdd(role: SalaoRole = 'garcom') {
    routes['/me'] = () => ({ json: me(role) })
    routes['/floor'] = () => ({ json: floor() })
    routes['/tabs/tab-1'] = () => ({ json: detail() })
    routes['/menu'] = () => ({ json: menu })
    const mounted = await mount()
    await click([...container.querySelectorAll('button')].find((b) => n(b.textContent).includes('12') && n(b.textContent).includes('R$ 110,00')))
    await click(button('Adicionar itens'))
    return mounted
  }

  it('produto simples entra no carrinho com um toque e o envio manda só ids e quantidades (nunca preço)', async () => {
    routes['POST /tabs/tab-1/rounds'] = () => ({ status: 201, json: { round_id: 'r2', round_number: 2, printed: true } })
    const { errors, restore } = await openAdd()
    expect(text()).toContain('Marmita P')
    await click([...container.querySelectorAll('li button')].find((b) => n(b.textContent).includes('Marmita P')))
    await click([...container.querySelectorAll('li button')].find((b) => n(b.textContent).includes('Marmita P')))
    expect(text()).toContain('Enviar para a cozinha · 2 itens · R$ 56,00')

    await click(button(/Enviar para a cozinha/))
    const sent = calls.find((c) => c.path === '/tabs/tab-1/rounds')?.body as { items: Record<string, unknown>[] }
    expect(sent.items).toEqual([{ product_id: 'p1', quantity: 2, addon_option_ids: [], notes: null }])
    expect(JSON.stringify(sent)).not.toMatch(/price|total/i)
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining('Rodada 2 enviada para a cozinha'))
    expect(window.localStorage.getItem('zk-salao-cart:tab-1')).toBeNull()
    expect(errors).toEqual([])
    restore()
  })

  it('produto com grupo obrigatório só entra depois de escolher a opção', async () => {
    const { restore } = await openAdd()
    await click([...container.querySelectorAll('li button')].find((b) => n(b.textContent).includes('Prato do dia')))
    const add = () => [...document.querySelectorAll('button')].find((b) => n(b.textContent).startsWith('Adicionar ·')) as HTMLButtonElement
    expect(add().disabled).toBe(true)
    expect(n(document.body.textContent)).toContain('Escolha uma opção em "Ponto da carne"')
    await click([...document.querySelectorAll('[role="radio"]')].find((b) => n(b.textContent).includes('Ao ponto')))
    expect(add().disabled).toBe(false)
    await click(add())
    expect(text()).toContain('Ao ponto')
    restore()
  })

  it('o carrinho sobrevive a fechar e abrir a tela (fica salvo no aparelho)', async () => {
    const { restore } = await openAdd()
    await click([...container.querySelectorAll('li button')].find((b) => n(b.textContent).includes('Marmita P')))
    expect(JSON.parse(window.localStorage.getItem('zk-salao-cart:tab-1')!)).toHaveLength(1)
    restore()
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    const again = await openAdd()
    expect(text()).toContain('Enviar para a cozinha · 1 item · R$ 28,00')
    again.restore()
  })

  it('erro do servidor mantém o carrinho para tentar de novo', async () => {
    routes['POST /tabs/tab-1/rounds'] = () => ({ status: 400, json: { error: 'addon_group_invalid', message: 'Prato do dia: escolha uma opção em "Ponto da carne".' } })
    const { restore } = await openAdd()
    await click([...container.querySelectorAll('li button')].find((b) => n(b.textContent).includes('Marmita P')))
    await click(button(/Enviar para a cozinha/))
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Prato do dia: escolha uma opção em "Ponto da carne".')
    expect(text()).toContain('Enviar para a cozinha · 1 item')
    restore()
  })
})

describe('caixa e leitura de QR', () => {
  it('caixa fechado: formulário de abertura para quem pode abrir', async () => {
    routes['/me'] = () => ({ json: me('caixa') })
    routes['/floor'] = () => ({ json: floor() })
    routes['/cash'] = () => ({ json: { cash: null, report: null, history: [] } })
    routes['POST /cash/open'] = () => ({ status: 201, json: { cash: {} } })
    const { errors, restore } = await mount()
    await click([...container.querySelectorAll('nav button')].find((b) => n(b.textContent).includes('Caixa')))
    expect(text()).toContain('O caixa está fechado')
    const input = container.querySelector('input[placeholder^="Fundo de troco"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '150,00')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button('Abrir caixa'))
    expect(calls.find((c) => c.path === '/cash/open')?.body).toEqual({ opening_float: 150 })
    expect(errors).toEqual([])
    restore()
  })

  it('garçom vê o caixa fechado mas sem formulário de abrir', async () => {
    routes['/me'] = () => ({ json: me('garcom') })
    routes['/floor'] = () => ({ json: floor() })
    routes['/cash'] = () => ({ json: { cash: null, report: null, history: [] } })
    const { restore } = await mount()
    await click([...container.querySelectorAll('nav button')].find((b) => n(b.textContent).includes('Caixa')))
    expect(text()).toContain('Peça ao caixa ou ao gerente para abrir.')
    expect(button('Abrir caixa')).toBeUndefined()
    restore()
  })

  it('tela de escanear monta sem câmera disponível e explica o que fazer', async () => {
    routes['/me'] = () => ({ json: me() })
    routes['/floor'] = () => ({ json: floor() })
    const { errors, restore } = await mount()
    await click([...container.querySelectorAll('nav button')].find((b) => n(b.textContent).includes('Escanear mesa')))
    expect(text()).toContain('Não foi possível usar a câmera')
    expect(errors).toEqual([])
    restore()
  })

  it('"Trocar usuário" encerra a sessão e volta para o PIN', async () => {
    let logged = true
    routes['/me'] = () => ({ json: logged ? me() : { state: 'pin_required', account_name: 'Concórdia' } })
    routes['/floor'] = () => ({ json: floor() })
    routes['POST /logout'] = () => {
      logged = false
      return { json: { ok: true } }
    }
    const { restore } = await mount()
    await click(button('Trocar usuário'))
    expect(text()).toContain('Digite seu PIN')
    restore()
  })

  it('entrando pelo painel (gerente sem PIN) mostra "Voltar ao painel" em vez de trocar usuário', async () => {
    routes['/me'] = () => ({ json: me('gerente', { actor: { name: 'Guilherme', role: 'gerente', via: 'panel' } }) })
    routes['/floor'] = () => ({ json: floor() })
    const { restore } = await mount()
    expect(text()).toContain('Voltar ao painel')
    expect(button('Trocar usuário')).toBeUndefined()
    restore()
  })
})
