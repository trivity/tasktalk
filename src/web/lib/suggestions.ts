const MARKER = 'SUGGESTED_NEXT:';

export function stripSuggestionsBlock(text: string): string {
  const idx = text.lastIndexOf(MARKER);
  if (idx < 0) return text;
  return text.slice(0, idx).trimEnd();
}

export function parseSuggestions(text: string): string[] {
  const idx = text.lastIndexOf(MARKER);
  if (idx < 0) return [];
  const after = text.slice(idx + MARKER.length).trim();
  const arrMatch = after.match(/^\[[\s\S]*?\]/);
  if (!arrMatch) return [];
  try {
    const parsed = JSON.parse(arrMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, 5);
  } catch {
    return [];
  }
}
