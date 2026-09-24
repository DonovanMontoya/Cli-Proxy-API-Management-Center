/**
 * Which models a credential cannot use.
 *
 * Codex reports availability per model in its usage payload, so that list is
 * data-driven. Claude exposes no such field; access follows the subscription
 * plan, so Claude restrictions are declared here per plan and must be kept in
 * sync with Anthropic's plan tiers.
 */

import type { QuotaProviderType } from './providers/types';

export interface ModelRestriction {
  model: string;
  /** 'plan' = implied by the subscription tier; 'reported' = the provider said so. */
  source: 'plan' | 'reported';
}

/** Claude plan → models that plan cannot use. Plan ids come from resolveClaudePlanType. */
export const CLAUDE_PLAN_RESTRICTED_MODELS: Record<string, readonly string[]> = {
  plan_free: ['Fable 5.1'],
  plan_pro: ['Fable 5.1'],
};

export function restrictedModelsFor(type: QuotaProviderType, quota: unknown): ModelRestriction[] {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return [];

  if (type === 'claude') {
    const planType = (quota as { planType?: string | null }).planType;
    if (!planType) return [];
    return (CLAUDE_PLAN_RESTRICTED_MODELS[planType] ?? []).map((model) => ({
      model,
      source: 'plan' as const,
    }));
  }

  if (type === 'codex') {
    const models = (quota as { unavailableModels?: string[] }).unavailableModels ?? [];
    return models.map((model) => ({ model, source: 'reported' as const }));
  }

  return [];
}
