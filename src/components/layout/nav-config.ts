import {
  Bot,
  BookOpen,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  Radio,
  UtensilsCrossed,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

export interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

export interface NavGroup {
  /** null renders no header — used for the top, ungrouped block. */
  labelKey: string | null;
  items: NavItem[];
  /** Renders the header as a toggle that shows/hides `items`. */
  collapsible?: boolean;
}

const DASHBOARD: NavItem = { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard };
// Same route as DASHBOARD, but for a restaurant "/dashboard" opens on
// today's orders — it is the app's home, so it reads "Início".
const HOME: NavItem = { href: "/dashboard", labelKey: "home", icon: LayoutDashboard };
const INBOX: NavItem = { href: "/inbox", labelKey: "inbox", icon: MessageSquare };
const CONTACTS: NavItem = { href: "/contacts", labelKey: "contacts", icon: Users };
const PIPELINES: NavItem = { href: "/pipelines", labelKey: "pipelines", icon: GitBranch };
const BROADCASTS: NavItem = { href: "/broadcasts", labelKey: "broadcasts", icon: Radio };
const AUTOMATIONS: NavItem = { href: "/automations", labelKey: "automations", icon: Zap };
const FLOWS: NavItem = { href: "/flows", labelKey: "flows", icon: Workflow, beta: true };
const AGENTS: NavItem = { href: "/agents", labelKey: "aiAgents", icon: Bot };

// Delivery (opt-in module, migration 041) and the menu/catalog CRUD
// that lives under it. Cardápio's href is a sub-path of Delivery's —
// the sidebar's longest-match rule keeps only one of them lit.
const ORDERS: NavItem = { href: "/delivery", labelKey: "orders", icon: UtensilsCrossed, beta: true };
const CARDAPIO: NavItem = { href: "/delivery/cardapio", labelKey: "cardapio", icon: BookOpen };

// Grouped so related messaging tools (Broadcasts/Automations/Flows/
// Agents) read as one section instead of 4 unrelated top-level items
// (UX audit Parte 1 — "mensageria está espalhada").
const BASE_NAV_GROUPS: NavGroup[] = [
  { labelKey: null, items: [DASHBOARD, INBOX, CONTACTS, PIPELINES] },
  { labelKey: "groupMessaging", items: [BROADCASTS, AUTOMATIONS, FLOWS, AGENTS] },
];

/**
 * Sidebar layout for the account's enabled modules.
 *
 * A restaurant using Delivery gets an iFood-partner-style menu: what it
 * touches every day (home with today's orders, order history, WhatsApp
 * inbox, menu) always in view, and the CRM tooling collapsed under "Mais ferramentas" — the
 * team kept getting lost between Funis/Transmissões/Fluxos while just
 * trying to take an order (Eder, 2026-10-23). Nothing is removed; every
 * route stays one click away. Accounts without Delivery keep the
 * original layout untouched.
 */
export function buildNavGroups(hasDelivery: boolean): NavGroup[] {
  if (!hasDelivery) return BASE_NAV_GROUPS;
  return [
    { labelKey: null, items: [HOME, ORDERS, INBOX, CARDAPIO] },
    {
      labelKey: "moreTools",
      collapsible: true,
      items: [CONTACTS, PIPELINES, BROADCASTS, AUTOMATIONS, FLOWS, AGENTS],
    },
  ];
}

/** True when `pathname` is the item's own page or anything below it. */
export function pathMatchesItem(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
