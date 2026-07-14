import { cfg } from '../config';

export function validateSignalModelConfig() {
  const model = cfg().signal_model;
  if (!model || typeof model !== 'object') throw new Error('signal_model configuration is missing');
  const unit = [
    'min_rank_percentile','min_target_before_stop','max_downside_probability','max_graph_risk',
    'max_burst_exhaustion','max_uncertainty','min_feature_completeness','min_execution_score',
    'min_independent_entity_ratio','regime_change_abstain_threshold',
  ] as const;
  const errors: string[] = [];
  for (const key of unit) {
    const value = Number(model[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`${key} must be between 0 and 1`);
  }
  if (!Number.isFinite(model.min_expected_value)) errors.push('min_expected_value must be finite');
  if (!Number.isFinite(model.decision_ttl_seconds) || model.decision_ttl_seconds < 10) errors.push('decision_ttl_seconds must be at least 10');
  if (!Number.isFinite(model.min_cohort_size) || model.min_cohort_size < 3) errors.push('min_cohort_size must be at least 3');
  if (!Number.isFinite(model.route_stability_max_bps) || model.route_stability_max_bps <= 0) errors.push('route_stability_max_bps must be positive');
  if (!Array.isArray(model.probe_sizes_sol) || !model.probe_sizes_sol.length || model.probe_sizes_sol.length > 5
      || model.probe_sizes_sol.some(value => !Number.isFinite(value) || value <= 0 || value > 5))
    errors.push('probe_sizes_sol must contain 1-5 positive values no larger than 5 SOL');
  if (errors.length) throw new Error(`invalid signal_model configuration: ${errors.join('; ')}`);
  return model;
}
