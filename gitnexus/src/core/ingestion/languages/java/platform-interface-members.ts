/**
 * Complete instance-member name inventories of JDK interfaces whose declarations are
 * not indexed (they live outside the repository).
 *
 * Why this exists: `hierarchyComplete` (overload-resolution.ts) must prove that no
 * ancestor can contribute another overload of the called name before a Java receiver
 * call may be resolved. An external ancestor was treated as an unknown inventory, so a
 * class that merely `implements java.io.Serializable` lost every `receiver.method()`
 * edge — and with it every subclass (a `BaseEntity implements Serializable` root
 * silenced all entity calls in a 8k-file codebase, 126k call sites).
 *
 * An interface listed here is a closed world: if the called name is not in its member
 * set, the interface cannot add a candidate and the lookup stays complete. A name that
 * IS in the set keeps the conservative "unknown inventory" outcome.
 *
 * Only add an interface when its full member list (abstract, default and static
 * methods) is certain; a missing name would make a lookup look complete when it is not.
 */
export const JAVA_PLATFORM_INTERFACE_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map<
  string,
  ReadonlySet<string>
>([
  // Marker interfaces: no members at all.
  ['java.io.Serializable', new Set<string>()],
  ['java.lang.Cloneable', new Set<string>()],
  ['java.util.RandomAccess', new Set<string>()],
  ['java.util.EventListener', new Set<string>()],
  // Single-method and small interfaces.
  ['java.lang.Comparable', new Set(['compareTo'])],
  ['java.lang.AutoCloseable', new Set(['close'])],
  ['java.io.Closeable', new Set(['close'])],
  ['java.util.concurrent.Callable', new Set(['call'])],
  ['java.util.function.Supplier', new Set(['get'])],
  ['java.lang.Iterable', new Set(['iterator', 'forEach', 'spliterator'])],
]);

/** True when `memberName` cannot be declared by the platform interface `typeName`. */
export function platformInterfaceLacksMember(typeName: string, memberName: string): boolean {
  const members = JAVA_PLATFORM_INTERFACE_MEMBERS.get(typeName);
  return members !== undefined && !members.has(memberName);
}
