import { requireValue } from '../http/errors';

// JSON.parse alone silently accepts duplicate keys, including escaped spellings.
export function parseJson(text: string): unknown {
  let at = 0;
  const space = () => {
    while (/[\t\n\r ]/.test(text[at] ?? 'x')) at++;
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') at++;
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new Error('invalid_json');
  }
  function value(depth: number): unknown {
    requireValue(depth <= 32);
    space();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++;
      const result: Record<string, unknown> = Object.create(null);
      space();
      if (text[at] === '}') {
        at++;
        return result;
      }
      for (;;) {
        space();
        requireValue(text[at] === '"');
        const key = string();
        requireValue(!Object.hasOwn(result, key));
        space();
        requireValue(text[at++] === ':');
        result[key] = value(depth + 1);
        space();
        const end = text[at++];
        if (end === '}') return result;
        requireValue(end === ',');
      }
    }
    if (text[at] === '[') {
      at++;
      const result: unknown[] = [];
      space();
      if (text[at] === ']') {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        space();
        const end = text[at++];
        if (end === ']') return result;
        requireValue(end === ',');
      }
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        text.slice(at),
      );
    requireValue(token);
    // The publication wire contract uses integer JSON tokens, as the Python consumer does.
    if (/^-?[0-9]/.test(token[0])) requireValue(!/[.eE]/.test(token[0]));
    at += token[0].length;
    return JSON.parse(token[0]) as unknown;
  }
  const result = value(0);
  space();
  requireValue(at === text.length);
  return result;
}

export function object(value: unknown): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

export function fields(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  const result = object(value);
  requireValue(
    Object.keys(result).length === keys.length &&
      keys.every((key) => Object.hasOwn(result, key)),
  );
  return result;
}
