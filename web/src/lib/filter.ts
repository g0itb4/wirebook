// The filter on the menu: which names answer what someone typed. Every word
// of the query is somewhere in the name, case aside, so "get widget" finds
// GetWidget and "widget get" finds it too.

export function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
}

export function matches(query: string, label: string): boolean {
  const text = label.toLowerCase();
  return words(query).every((word) => text.includes(word));
}

/** What the menu says under its filter. */
export function summary(query: string, shown: number, total: number): string {
  if (words(query).length === 0) return "";
  if (shown === 0) return `Nothing in the menu matches “${query.trim()}”.`;
  return `${shown} of ${total}`;
}
