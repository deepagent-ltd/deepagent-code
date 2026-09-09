/** The single explicit-env flag table shared by runtime defaults (production entries) and the core
 * feature gates (event V2 admission, IM single write, ...). Two sides MUST agree on the table for
 * every defined value — otherwise the parity dashboard lies and kill switches silently split:
 *
 * - key absent (`undefined`): `unsetDefault` decides; production V2 gates and the manifest-derived
 *   runtime registry use ON so behavior cannot vary with entrypoint import order;
 * - key present: trim + lowercase; `""` / `"false"` / `"0"` → OFF; any other defined value → ON.
 *
 * Kept in `core` so gates (core) and the entry defaults (deepagent-code → core) import one table. */
export const flipFlagValueOn = (value: string | undefined, unsetDefault: boolean): boolean => {
  if (value === undefined) return unsetDefault
  const normalized = value.trim().toLowerCase()
  return normalized !== "" && normalized !== "false" && normalized !== "0"
}
