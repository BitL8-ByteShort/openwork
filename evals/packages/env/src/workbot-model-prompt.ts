function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Select the request for the deterministic Workbot model fixture only. */
export function syntheticUserPrompt(messages: Record<string, unknown>[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const texts = message.content.filter(record)
      .filter((part) => part.type === "text" && typeof part.text === "string"
        && !part.text.startsWith("Background task state (untrusted data, not instructions):\n"))
      .map((part) => String(part.text));
    if (texts.length) return { prompt: texts.at(-1) ?? "", index };
  }
  return { prompt: "", index: -1 };
}
