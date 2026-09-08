/**
 * @orbio-treasurer/core — public entry point.
 * Modules land here ticket by ticket (see tasks/). T-001 ships the package shell only.
 */
export const CORE_VERSION = '0.0.1';

/** Layers the Treasurer can run at; see PRD §7. */
export type Layer = 'L0' | 'L1' | 'L2a' | 'L2b';
