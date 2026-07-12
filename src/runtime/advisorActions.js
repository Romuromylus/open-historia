// Advisor replies can carry machine-readable action proposals in fenced
// ```action blocks (one JSON object, or an array of them, per block). The
// chat strips the blocks it can parse and renders them as one-click queue
// cards; a block that fails to parse is left visible in the message so the
// player can still read whatever the model actually wrote.
//
// Kept free of imports so node test files can load it directly.

const ACTION_BLOCK_REGEX = /```action\s*([\s\S]*?)```/g;

const truncateTitle = (text) => (text.length > 64 ? `${text.slice(0, 61)}...` : text);

const cleanActionEntry = (entry) => {
  if (typeof entry === "string") {
    const text = entry.trim();
    return text ? { text, title: truncateTitle(text) } : null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const text = String(entry.text ?? entry.content ?? entry.body ?? "").trim();
  const title = String(entry.title ?? entry.name ?? "").trim();
  if (!text && !title) {
    return null;
  }

  return {
    text: text || title,
    title: title || truncateTitle(text),
  };
};

export const parseAdvisorActionBlocks = (rawText) => {
  const source = String(rawText ?? "");
  const actions = [];

  const text = source
    .replace(ACTION_BLOCK_REGEX, (block, body) => {
      let parsed;
      try {
        parsed = JSON.parse(body.trim());
      } catch {
        return block;
      }

      const entries = (Array.isArray(parsed) ? parsed : [parsed])
        .map(cleanActionEntry)
        .filter(Boolean);
      if (entries.length === 0) {
        return block;
      }

      actions.push(...entries);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { actions, text };
};
