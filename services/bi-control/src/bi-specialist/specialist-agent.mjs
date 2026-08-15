import { discoverDatabase } from './progressive-discovery.mjs';
import { selectPlanningPolicy } from './planning-policy.mjs';

export const SPECIALIST_AGENT_VERSION = 'chimpmaera.bi/real-bi-specialist/v1';

export class RealBiSpecialist {
  constructor({ adapter = null } = {}) { this.adapter = adapter; }

  async investigate({ databasePath, objective, underspecified = false, adversarial = false, modelSynthesis = false, runId = 'run-1' }) {
    const policy = selectPlanningPolicy(objective, { underspecified, adversarial });
    const discovery = discoverDatabase({ databasePath, objective });
    let synthesis = {
      source: 'deterministic-evidence-core',
      summary: `${discovery.structuralInventory.length} entities, ${discovery.entityProcessRelationshipGraph.length} relationships, ${discovery.anomalyQualityCauseHypotheses.anomalies.length} bounded-sample anomalies.`,
      claimsBounded: true,
    };
    if (modelSynthesis) {
      if (!this.adapter) throw Object.assign(new Error('MODEL_ADAPTER_REQUIRED'), { code: 'MODEL_ADAPTER_REQUIRED' });
      const compact = {
        objective,
        entities: discovery.structuralInventory.map((table) => ({ name: table.name, columns: table.columns.map((column) => column.name) })),
        relationships: discovery.entityProcessRelationshipGraph,
        anomalies: discovery.anomalyQualityCauseHypotheses.anomalies,
        kpis: discovery.semanticKpiModel.kpis,
        blindSpots: discovery.evidenceConfidenceBlindSpots.blindSpots,
      };
      const response = await this.adapter.complete({
        idempotencyKey: `${runId}:synthesis`,
        messages: [
          { role: 'system', content: 'Return one JSON object only with exactly these fields: summary (string), evidence_tables (array of table names from the input), confidence (number 0..1), blind_spots (array of strings), persistence_proposed (false). Never invent values, causal claims, table names, or persistence. Do not expose reasoning.' },
          { role: 'user', content: JSON.stringify(compact) },
        ],
        ...policy.samplingProfile,
        responseFormat: { type: 'json_object' },
      });
      let parsed;
      try { parsed = JSON.parse(response.content); } catch { throw Object.assign(new Error('MODEL_SYNTHESIS_JSON_INVALID'), { code: 'MODEL_SYNTHESIS_JSON_INVALID' }); }
      synthesis = { source: 'local-model', observable: parsed, receipt: response.receipt, claimsBounded: true };
    }
    return {
      schemaVersion: SPECIALIST_AGENT_VERSION,
      runId,
      plan_summary: { taskClass: policy.taskClass, pattern: policy.pattern, stepBudget: policy.stepBudget, persistentActionAllowed: false },
      decision_record: { policyVersion: policy.schemaVersion, samplingProfile: policy.samplingProfile, rationale: 'deterministic task classification and bounded evidence depth' },
      tool_trace: discovery.evidenceConfidenceBlindSpots.evidenceReceipts,
      self_check: { budgetsGreen: discovery.budgetUsage.withinBudget, citationsPresent: discovery.evidenceConfidenceBlindSpots.evidenceReceipts.length > 0, mutationPerformed: false },
      correction_record: [],
      discovery,
      synthesis,
    };
  }
}
