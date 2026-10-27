'use client';

import { createContext, useContext } from 'react';
import type { SalaoAction } from '@/lib/salao/permissions';
import type { Me } from './types';

export type View =
  | { name: 'floor' }
  | { name: 'tab'; id: string }
  | { name: 'add'; id: string }
  | { name: 'cash' }
  | { name: 'scan' };

export interface SalaoUi {
  me: Me;
  can: (action: SalaoAction) => boolean;
  fmt: (value: number) => string;
  go: (view: View) => void;
  back: () => void;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;
}

export const SalaoUiContext = createContext<SalaoUi | null>(null);

export function useSalao(): SalaoUi {
  const ctx = useContext(SalaoUiContext);
  if (!ctx) throw new Error('useSalao fora do SalaoApp');
  return ctx;
}
