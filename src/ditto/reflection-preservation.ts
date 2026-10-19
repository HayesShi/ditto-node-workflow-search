/** Prove a narrow syntax repair when the original JSON cannot be parsed.
 * Every quoted literal, number, boolean, null and container delimiter must
 * survive verbatim and in order. Only separators/whitespace may change; a lone
 * stray quote immediately before an existing container close may be removed.
 * No prose, second object, missing container, changed escape or answer is lost.
 */
export function preservesJsonPayload(source: string, repaired: string): boolean {
  const original = stripFence(source), candidate = stripFence(repaired);
  try { JSON.parse(candidate); } catch { return false; }
  let from = 0, to = 0;
  const skip = (text: string, position: number): number => {
    while (position < text.length && /[\s,:]/.test(text[position]!)) position++;
    return position;
  };
  while ((to = skip(candidate, to)) < candidate.length) {
    const start = to, first = candidate[to]!;
    if ('{}[]'.includes(first)) to++;
    else if (first === '"') {
      to++;
      while (to < candidate.length) {
        const next = candidate[to++]!;
        if (next === '\\') to++;
        else if (next === '"') break;
      }
    } else {
      while (to < candidate.length && !/[\s,:{}\[\]]/.test(candidate[to]!)) to++;
    }
    const token = candidate.slice(start, to);
    from = skip(original, from);
    // The recorded malformed reply contains ,"} instead of }. Removing this
    // orphan quote cannot remove any string value: the next token must be the
    // same existing closing delimiter, not a quoted literal or new container.
    if ((token === '}' || token === ']') && original[from] === '"') {
      let after = from + 1;
      while (/\s/.test(original[after] ?? '') && after < original.length) after++;
      if (original[after] === token) from = after;
    }
    if (!original.startsWith(token, from)) return false;
    from += token.length;
  }
  return skip(original, from) === original.length;
}

function stripFence(content: string): string {
  return content.replace(/^\s*```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
}
