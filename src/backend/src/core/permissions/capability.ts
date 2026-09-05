/**
 * Capability System — Core Permissions Primitives
 *
 * Defines the capability string union, capability sets, and core operations.
 * This module is the foundation for all permission checks in the runtime.
 *
 * Capabilities (P1-33):
 * - filesystem.read
 * - filesystem.write
 * - filesystem.delete
 * - terminal.execute
 * - network.http
 * - browser.control
 * - browser.download
 * - mcp.execute
 * - secrets.read
 * - process.launch
 *
 * Additional capability strings are allowed via the escape hatch.
 */

// ============================================================================
// Capability Type Union
// ============================================================================

/**
 * Core capability string literals.
 * The `(string & {})` escape hatch allows additional capability strings
 * while preserving type safety for the known set.
 */
export type Capability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'terminal.execute'
  | 'network.http'
  | 'browser.control'
  | 'browser.download'
  | 'mcp.execute'
  | 'secrets.read'
  | 'process.launch'
  | (string & {});

/**
 * Readonly set of capabilities.
 * Use `createCapabilitySet()` to construct.
 */
export type CapabilitySet = ReadonlySet<Capability>;

/**
 * All 10 core capabilities as a readonly array.
 * Useful for iteration, validation, and UI enumeration.
 */
export const ALL_CAPABILITIES: readonly Capability[] = [
  'filesystem.read',
  'filesystem.write',
  'filesystem.delete',
  'terminal.execute',
  'network.http',
  'browser.control',
  'browser.download',
  'mcp.execute',
  'secrets.read',
  'process.launch',
] as const;

// ============================================================================
// Capability Set Operations
// ============================================================================

/**
 * Creates a new CapabilitySet from the given capabilities.
 *
 * @param caps - Capability strings to include in the set
 * @returns A readonly Set containing the unique capabilities
 *
 * @example
 * ```ts
 * const set = createCapabilitySet('filesystem.read', 'network.http');
 * hasCapability(set, 'filesystem.read'); // true
 * ```
 */
export function createCapabilitySet(...caps: Capability[]): CapabilitySet {
  return new Set(caps) as CapabilitySet;
}

/**
 * Checks if a capability set contains a specific capability.
 *
 * @param set - The capability set to check
 * @param cap - The capability to look for
 * @returns true if the set contains the capability, false otherwise
 */
export function hasCapability(set: CapabilitySet, cap: Capability): boolean {
  return set.has(cap);
}

/**
 * Combines multiple capability sets into a single union set.
 *
 * @param sets - Capability sets to combine
 * @returns A new CapabilitySet containing all unique capabilities from all input sets
 *
 * @example
 * ```ts
 * const combined = combineCapabilities(
 *   createCapabilitySet('filesystem.read'),
 *   createCapabilitySet('network.http', 'terminal.execute')
 * );
 * // combined has: filesystem.read, network.http, terminal.execute
 * ```
 */
export function combineCapabilities(...sets: CapabilitySet[]): CapabilitySet {
  const combined = new Set<Capability>();
  for (const set of sets) {
    for (const cap of set) {
      combined.add(cap);
    }
  }
  return combined as CapabilitySet;
}

/**
 * Checks if a capability set is a superset of another (contains all capabilities).
 *
 * @param superset - The set that should contain all capabilities
 * @param subset - The set whose capabilities should all be in superset
 * @returns true if superset contains every capability in subset
 */
export function isSuperset(superset: CapabilitySet, subset: CapabilitySet): boolean {
  for (const cap of subset) {
    if (!superset.has(cap)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the difference between two capability sets (capabilities in first but not in second).
 *
 * @param set - The base set
 * @param subtract - The set to subtract
 * @returns A new CapabilitySet with capabilities only in `set`
 */
export function difference(set: CapabilitySet, subtract: CapabilitySet): CapabilitySet {
  const result = new Set<Capability>();
  for (const cap of set) {
    if (!subtract.has(cap)) {
      result.add(cap);
    }
  }
  return result as CapabilitySet;
}

/**
 * Returns the intersection of two capability sets.
 *
 * @param a - First set
 * @param b - Second set
 * @returns A new CapabilitySet with capabilities present in both sets
 */
export function intersection(a: CapabilitySet, b: CapabilitySet): CapabilitySet {
  const result = new Set<Capability>();
  for (const cap of a) {
    if (b.has(cap)) {
      result.add(cap);
    }
  }
  return result as CapabilitySet;
}