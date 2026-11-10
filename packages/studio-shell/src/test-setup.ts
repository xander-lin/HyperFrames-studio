/**
 * Shared test environment setup.
 *
 * Runs for every test file that declares an environment (`jsdom` / `happy-dom`), not for
 * the bare-node ones.
 */

if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = {};
}
if (typeof CSS.escape !== "function") {
  CSS.escape = (value: string) => value.replace(/([^\w-])/g, "\\$1");
}

// happy-dom does not implement `window.confirm`. Vitest 3 let `vi.spyOn` invent
// a missing property; Vitest 4 refuses with "can only spy on a function", so the
// environment has to supply a real one for the guard tests to replace. Declining
// is the safe default: no test calls it without stubbing a return value first.
if (typeof globalThis.confirm !== "function") {
  (globalThis as Record<string, unknown>).confirm = () => false;
}

/**
 * `localStorage`, when the environment does not expose it.
 *
 * happy-dom constructs one, but under Vitest 4 it is not reachable from `window` here, and
 * the dock tests legitimately use it (the layout and the toolbar remember their positions).
 * A plain Map-backed shim is enough: nothing under test depends on persistence across a
 * process, only on "store this and read it back".
 */
function installStorageShim(name: "localStorage" | "sessionStorage"): void {
  if (typeof (window as unknown as Record<string, unknown>)[name] !== "undefined") return;
  const values = new Map<string, string>();
  const shim = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, name, { value: shim, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, name, { value: shim, configurable: true, writable: true });
  }
}

if (typeof window !== "undefined") {
  installStorageShim("localStorage");
  installStorageShim("sessionStorage");
}
