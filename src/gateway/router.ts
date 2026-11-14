/**
 * Namespacing for aggregated servers.
 *
 * Every mounted server has its own name space for tools, prompts and resources,
 * and collisions are common (`read_file` exists in at least a dozen packages).
 * Everything is therefore exposed as `<alias>__<name>` and routed back through
 * an explicit registry rather than by parsing strings at call time -- except
 * where the protocol forces a flat string, and there the alias separator is
 * reserved so the split is unambiguous.
 */
import { sanitize } from "../security/sanitize.js";

export const SEPARATOR = "__";

export interface NamespacedItem {
  alias: string;
  original: string;
  namespaced: string;
}

export class NamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamespaceError";
  }
}

export function namespaceName(alias: string, name: string): string {
  return `${alias}${SEPARATOR}${name}`;
}

export function splitNamespaced(value: string): { alias: string; name: string } | null {
  const index = value.indexOf(SEPARATOR);
  if (index <= 0) return null;
  const alias = value.slice(0, index);
  const name = value.slice(index + SEPARATOR.length);
  if (!alias || !name) return null;
  return { alias, name };
}

/** Aliases may not contain the separator, or routing becomes ambiguous. */
export function validateAlias(alias: string): void {
  if (!/^[a-zA-Z0-9._-]{1,40}$/.test(alias)) {
    throw new NamespaceError(
      `alias "${alias}" must match [a-zA-Z0-9._-] and be at most 40 characters`,
    );
  }
  if (alias.includes(SEPARATOR)) {
    throw new NamespaceError(`alias "${alias}" must not contain "${SEPARATOR}"`);
  }
}

export class NamespaceRegistry {
  private readonly tools = new Map<string, NamespacedItem>();
  private readonly prompts = new Map<string, NamespacedItem>();
  private readonly resources = new Map<string, NamespacedItem>();

  registerTool(alias: string, name: string): NamespacedItem {
    const item: NamespacedItem = {
      alias,
      original: name,
      namespaced: namespaceName(alias, name),
    };
    this.tools.set(item.namespaced, item);
    return item;
  }

  registerPrompt(alias: string, name: string): NamespacedItem {
    const item: NamespacedItem = {
      alias,
      original: name,
      namespaced: namespaceName(alias, name),
    };
    this.prompts.set(item.namespaced, item);
    return item;
  }

  registerResource(alias: string, uri: string): NamespacedItem {
    const item: NamespacedItem = {
      alias,
      original: uri,
      namespaced: rewriteResourceUri(alias, uri),
    };
    this.resources.set(item.namespaced, item);
    return item;
  }

  resolveTool(namespaced: string): NamespacedItem | undefined {
    return this.tools.get(namespaced);
  }

  resolvePrompt(namespaced: string): NamespacedItem | undefined {
    return this.prompts.get(namespaced);
  }

  resolveResource(namespaced: string): NamespacedItem | undefined {
    return this.resources.get(namespaced);
  }

  toolsForAlias(alias: string): NamespacedItem[] {
    return [...this.tools.values()].filter((item) => item.alias === alias);
  }

  allTools(): NamespacedItem[] {
    return [...this.tools.values()];
  }

  allPrompts(): NamespacedItem[] {
    return [...this.prompts.values()];
  }

  allResources(): NamespacedItem[] {
    return [...this.resources.values()];
  }

  clearAlias(alias: string): void {
    for (const map of [this.tools, this.prompts, this.resources]) {
      for (const [key, item] of map) {
        if (item.alias === alias) map.delete(key);
      }
    }
  }
}

/**
 * Resource URIs are opaque strings owned by the upstream server, so they are
 * preserved verbatim inside a wrapper URI instead of being rewritten.
 */
export function rewriteResourceUri(alias: string, uri: string): string {
  return `mcp-index://${alias}/${encodeURIComponent(uri)}`;
}

export function unrewriteResourceUri(namespaced: string): string | null {
  if (!namespaced.startsWith("mcp-index://")) return null;
  const rest = namespaced.slice("mcp-index://".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  try {
    return decodeURIComponent(rest.slice(slash + 1));
  } catch {
    return null;
  }
}

/** Tool descriptions are third-party text; strip control sequences only. */
export function cleanDescription(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = sanitize(value, { multiline: true, maxLength: 2_000 });
  return cleaned.length > 0 ? cleaned : undefined;
}
