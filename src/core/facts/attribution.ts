/**
 * Speaker attribution compatibility: the one rule every fact dedup path
 * applies before candidate limits and similarity decisions.
 *
 * `attributed_to` records WHO asserted a claim (user, assistant, a named
 * other party), never whether it is true or accepted. Two facts asserted by
 * different known speakers are never duplicates of each other: "Assistant
 * recommended the Lisbon hostel" must not collapse into, supersede, or be
 * swallowed by the user's own claim. NULL (attribution unavailable: older
 * facts, non-conversation text) is compatible with either speaker, so
 * brains without attribution keep their existing dedup behavior.
 */
import type { FactAttribution } from '../engine.ts';

export function attributionCompatible(a: FactAttribution | null | undefined, b: FactAttribution | null | undefined): boolean {
  return !a || !b || a === b;
}
