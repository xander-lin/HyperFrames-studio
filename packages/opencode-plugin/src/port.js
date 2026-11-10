/**
 * Parse the inbox port from an environment value.
 *
 * Returns null for anything that is not a usable TCP port, so the caller can say
 * "the inbox is off" instead of crashing on `NaN` deep inside `server.listen`.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parsePort(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const port = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}
