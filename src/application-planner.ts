import { existsSync, readFileSync } from 'node:fs';
import { InformationPlanner } from './information-planner';
import type { PlannerConfig } from './model-client';

/** Application settings contain endpoint/model only. Bearer credentials stay in the process environment. */
export function applicationInformationPlanner(env: Record<string, string | undefined> = process.env): InformationPlanner {
  const path = new URL('../model-config.json', import.meta.url);
  let settings: Partial<PlannerConfig> = {};
  if (existsSync(path)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('PLANNER_CONFIGURATION'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['mode', 'endpoint', 'model'].includes(key))) throw new Error('PLANNER_CONFIGURATION');
    const config = raw as Record<string, unknown>;
    if (Object.values(config).some(value => typeof value !== 'string')) throw new Error('PLANNER_CONFIGURATION');
    settings = config as Partial<PlannerConfig>;
  }
  return InformationPlanner.fromEnvironment({
    ...env,
    AUTOMATE_PLANNER: env.AUTOMATE_PLANNER ?? settings.mode,
    AUTOMATE_MODEL_ENDPOINT: env.AUTOMATE_MODEL_ENDPOINT ?? settings.endpoint,
    AUTOMATE_MODEL: env.AUTOMATE_MODEL ?? settings.model,
  });
}
