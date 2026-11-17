import { SsoError, SSO_ERROR_CODES } from './errors.js';

/**
 * Parse an HTTP query string into the shape {@link createMjuSsoAdapter}.handleCallback expects.
 *
 * The adapter refuses a callback that carries more than one `ac` (`SSO_CALLBACK_DUPLICATE`) by
 * looking for an **array**. That refusal is only as strong as the parser in front of it:
 *
 * ```js
 * Object.fromEntries(new URL('?ac=one&ac=two').searchParams); // { ac: 'two' }
 * ```
 *
 * "Last one wins" silently discards the first code, so a callback carrying two codes looks like a
 * normal single-code callback and the duplicate refusal never fires. Repetition must be preserved:
 * a key that appears more than once becomes an array, and the adapter can then refuse it before any
 * provider call.
 *
 * Use this — or a parser with the same property, such as Express's default `qs` — in every consumer.
 *
 * @param {URLSearchParams} searchParams
 * @returns {Record<string, string|string[]>}
 */
export function parseCallbackQuery(searchParams) {
  if (!(searchParams instanceof URLSearchParams)) {
    throw new SsoError(SSO_ERROR_CODES.CALLBACK_INVALID, {
      status: 500,
      message: 'parseCallbackQuery expects a URLSearchParams instance',
    });
  }
  /** @type {Record<string, string|string[]>} */
  // A null-prototype object: a repeated `__proto__` key is then just an ordinary property instead
  // of an assignment onto Object.prototype. The `ac` lookup is unaffected either way; this removes
  // the class of concern rather than reasoning about it every time.
  const query = Object.create(null);
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
}
