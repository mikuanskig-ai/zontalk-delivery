// Formas das respostas de /api/salao/* usadas pelas telas do salão.

import type { SalaoAction, SalaoRole } from '@/lib/salao/permissions';

export interface Me {
  state: 'ok';
  account: { name: string; currency: string; slug: string | null };
  actor: { name: string; role: SalaoRole; via: 'device' | 'panel' };
  permissions: Record<SalaoAction, boolean>;
  settings: { service_fee_percent: number; require_open_cash: boolean };
  cash_open: boolean;
}

export interface FloorTab {
  id: string;
  total: number;
  guests: number;
  opened_at: string;
  opened_by_name: string;
  status: 'open' | 'bill_requested';
  bill_requested_at: string | null;
}

export interface FloorTable {
  id: string;
  number: number;
  name: string | null;
  area: string | null;
  status: 'free' | 'open' | 'bill_requested';
  tab: FloorTab | null;
}

export interface CounterTab {
  id: string;
  label: string;
  total: number;
  opened_at: string;
  opened_by_name: string;
  status: 'open' | 'bill_requested';
}

export interface CashSession {
  id: string;
  status: 'open' | 'closed';
  opening_float: number;
  opened_by_name: string;
  opened_at: string;
  closed_by_name: string | null;
  closed_at: string | null;
  counted_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
  notes: string | null;
}

export interface Floor {
  tables: FloorTable[];
  counter_tabs: CounterTab[];
  cash: CashSession | null;
  totals: { open_tabs: number; open_total: number };
  server_time: string;
}

export interface AddonOption {
  id: string;
  name: string;
  price_delta: number;
}

export interface AddonGroup {
  id: string;
  name: string;
  selection_type: 'single' | 'multiple';
  is_required: boolean;
  min_select: number;
  max_select: number | null;
  options: AddonOption[];
}

export interface MenuProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  addon_groups: AddonGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  products: MenuProduct[];
}

export interface MenuResponse {
  categories: MenuCategory[];
  uncategorized: MenuProduct[];
  currency: string;
}

export interface Tab {
  id: string;
  table_id: string | null;
  label: string;
  status: 'open' | 'bill_requested' | 'closed' | 'cancelled';
  guests: number;
  customer_name: string | null;
  opened_by_name: string;
  opened_at: string;
  bill_requested_at: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  service_fee_enabled: boolean;
  service_fee_percent: number;
  discount_amount: number;
  subtotal: number;
  service_fee_amount: number;
  total: number;
}

export interface TabRound {
  id: string;
  number: number;
  sent_by_name: string;
  created_at: string;
}

export interface TabItem {
  id: string;
  round_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  addons_snapshot: { group_name?: string; option_name?: string }[];
  line_total: number;
  notes: string | null;
  status: 'active' | 'cancelled';
  cancelled_reason: string | null;
  cancelled_by_name: string | null;
}

export interface TabPayment {
  id: string;
  method: 'pix' | 'credit' | 'debit' | 'cash' | 'other';
  amount: number;
  tendered: number | null;
  change_amount: number;
  received_by_name: string;
}

export interface TabDetail {
  tab: Tab;
  rounds: TabRound[];
  items: TabItem[];
  payments: TabPayment[];
}

export type PaymentMethod = TabPayment['method'];

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  pix: 'Pix',
  credit: 'Crédito',
  debit: 'Débito',
  cash: 'Dinheiro',
  other: 'Outro',
};
