// Escape text for HTML built as a string: element content and quoted attribute values alike.
// Quotes matter as much as brackets: the UI lane puts strings the app page sent (a selector, a
// page title) into attributes, and an unescaped quote would end the attribute and start a handler.
export function esc(s: unknown) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c: string) =>
      (
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<
          string,
          string
        >
      )[c] ?? c,
  );
}
