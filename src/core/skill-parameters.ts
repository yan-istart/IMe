import type { SkillDocument } from './knowledge.js';

export type SkillBindings = Record<string, string>;
const parameterName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Parameters select observed catalog targets, never executable tool arguments. */
export function validateParameters(document: SkillDocument): void {
  const parameters = document.parameters ?? {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || Object.keys(parameters).length > 5) throw new Error('INVALID_SKILL_PARAMETERS');
  for (const [name, parameter] of Object.entries(parameters)) {
    if (!parameterName.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)
      || !parameter || !Array.isArray(parameter.values) || parameter.values.length < 2
      || parameter.values.length > 20 || new Set(parameter.values).size !== parameter.values.length
      || parameter.values.some(value => typeof value !== 'string' || !value.trim() || value.length > 2000)) {
      throw new Error('INVALID_SKILL_PARAMETERS');
    }
    if (!document.steps.some(step => step.targetParameter === name)) throw new Error('UNUSED_SKILL_PARAMETER');
  }
  for (const step of document.steps) {
    if (step.targetParameter !== undefined && (!Object.hasOwn(parameters, step.targetParameter)
      || !parameters[step.targetParameter]!.values.includes(step.target))) throw new Error('INVALID_SKILL_PARAMETER_TARGET');
  }
}

export function bindSkill(document: SkillDocument, bindings: SkillBindings = {}): SkillDocument {
  validateParameters(document);
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('INVALID_SKILL_BINDINGS');
  const parameters = document.parameters ?? {};
  for (const [name, value] of Object.entries(bindings)) {
    if (!Object.hasOwn(parameters, name) || !parameters[name]!.values.includes(value)) throw new Error('INVALID_SKILL_BINDINGS');
  }
  return { ...document, steps: document.steps.map(step => ({ ...step,
    target: step.targetParameter ? (Object.hasOwn(bindings, step.targetParameter)
      ? bindings[step.targetParameter]! : parameters[step.targetParameter]!.values[0]!) : step.target })) };
}

/** Bound the full Cartesian product, so publication cannot skip combinations. */
export function skillVariants(document: SkillDocument): SkillBindings[] {
  validateParameters(document);
  let variants: SkillBindings[] = [{}];
  for (const [name, parameter] of Object.entries(document.parameters ?? {})) {
    if (variants.length * parameter.values.length > 20) throw new Error('TOO_MANY_SKILL_VARIANTS');
    variants = variants.flatMap(values => parameter.values.map(value => ({ ...values, [name]: value })));
  }
  return variants;
}
