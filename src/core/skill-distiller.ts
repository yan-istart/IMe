import { skillKey, skillSignature, type SkillDocument } from './knowledge.js';
import type { Runtime } from './runtime.js';

/** Conservative generalization: only varying finite target IDs become enums. */
export function distillSkill(runtime: Runtime, taskIds: string[]): { id: string; version: number } {
  if (!Array.isArray(taskIds) || taskIds.length < 3 || taskIds.length > 20
    || new Set(taskIds).size !== taskIds.length || taskIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('INDEPENDENT_TRAJECTORIES_REQUIRED');
  }
  const tasks = taskIds.map(id => runtime.tasks.get(id));
  if (tasks.some(task => task.status !== 'succeeded' || task.session_id === 'ime:evaluation')
    || new Set(tasks.map(task => task.session_id)).size < 2) throw new Error('INDEPENDENT_TRAJECTORIES_REQUIRED');
  const first = tasks[0]!;
  const key = skillKey(first.app, first.goal);
  if (tasks.some(task => skillKey(task.app, task.goal) !== key)) throw new Error('TRAJECTORY_GOAL_MISMATCH');
  const documents: SkillDocument[] = tasks.map(task => {
    const rows = runtime.store.db.prepare('SELECT state,data FROM actions WHERE task_id=? ORDER BY rowid').all(task.id);
    const checkpoints = runtime.store.db.prepare('SELECT * FROM checkpoints WHERE task_id=? ORDER BY rowid').all(task.id);
    if (!rows.length || rows.some(row => row.state !== 'verified') || !checkpoints.length
      || new Set(checkpoints.map(row => row.fingerprint)).size !== 1) throw new Error('VERIFIED_EVIDENCE_REQUIRED');
    const actions = rows.map(row => JSON.parse(String(row.data)));
    if (actions.some(action => typeof action.beforeState !== 'string' || typeof action.verifiedState !== 'string')) throw new Error('VERIFIED_EVIDENCE_REQUIRED');
    return { goal: first.goal, app: task.app, fingerprint: String(checkpoints[0]!.fingerprint),
      precondition: actions[0].beforeState, steps: actions.map(action => ({ kind: action.kind, target: action.target,
        expectedState: action.verifiedState, risk: action.risk, timeoutMs: action.timeoutMs })),
      evidenceRefs: checkpoints.map(row => String(row.evidence)) };
  });
  const shape = (document: SkillDocument) => skillSignature({ ...document,
    steps: document.steps.map(step => ({ ...step, target: 'variable' })) });
  if (documents.some(document => shape(document) !== shape(documents[0]!))) throw new Error('TRAJECTORY_STRUCTURE_MISMATCH');
  const document = structuredClone(documents[0]!);
  document.parameters = {};
  document.steps.forEach((step, index) => {
    const values = [...new Set(documents.map(item => item.steps[index]!.target))];
    if (values.length > 1) {
      const name = `target${index + 1}`;
      document.parameters![name] = { values };
      step.targetParameter = name;
    }
  });
  if (!Object.keys(document.parameters).length) throw new Error('NO_PARAMETER_VARIATION');
  document.evidenceRefs = [...new Set(documents.flatMap(item => item.evidenceRefs))];
  const proposed = runtime.knowledge.proposeSkill(document, key);
  runtime.store.event('ime.skill.distilled', { skillId: proposed.id, version: proposed.version, taskIds });
  return proposed;
}
