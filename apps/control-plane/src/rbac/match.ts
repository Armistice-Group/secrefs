/**
 * Matches a requested secret path against a `Grant.path_pattern`
 * (docs/control-plane-design.md §6). Deliberately minimal - three shapes:
 *
 *   "prod/db"      exact match only
 *   "prod/db/*"    prefix match: "prod/db/" + anything (NOT "prod/db"
 *                  itself, and NOT "prod/db2/..." - the trailing slash in
 *                  the prefix check prevents that sibling-path collision)
 *   "*"            matches every path
 *
 * No mid-pattern wildcards, no regex - if a real glob library turns out to
 * be needed later, swap the implementation, not the call sites.
 */
export function matchesPathPattern(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  if (pattern === path) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // "prod/db/*" -> "prod/db/"
    return path.startsWith(prefix);
  }
  return false;
}
