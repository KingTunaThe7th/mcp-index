/**
 * awesome-mcp-servers source.
 *
 * The list is a hand-maintained markdown file, not an API. It provides two
 * things the registry does not: human-written one-line summaries, and a
 * category taxonomy. Both come from untrusted text and are sanitized later.
 *
 * Parsing is line-oriented and forgiving: a malformed line is skipped, headers
 * inherit as categories, and emoji markers carry language/official metadata.
 */
import { DEFAULT_AWESOME_URL, USER_AGENT } from "../config.js";
import type { RawServer } from "../types.js";
import { fetchText } from "../util/fetch.js";

const LANGUAGE_EMOJI: Array<[string, string]> = [
  ["🐍", "python"],
  ["📇", "typescript"],
  ["🏎️", "go"],
  ["🏎", "go"],
  ["🦀", "rust"],
  ["#️⃣", "csharp"],
  ["☕", "java"],
  ["💎", "ruby"],
  ["🐘", "php"],
  ["🦊", "elixir"],
  ["🎗️", "reasonml"],
  ["🎗", "reasonml"],
  ["☁️", "cloud"],
  ["☁", "cloud"],
  ["🏠", "local"],
  ["📟", "embedded"],
];

const OFFICIAL_MARKERS = ["🎖️", "🎖", "🏆"];

const ENTRY_RE = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(.*)$/u;
const INLINE_LINK_RE = /!?\[[^\]]*\]\([^)]*\)/gu;
const SEPARATOR_RE = /\s+[-–—]\s+/u;
const HEADING_RE = /^(#{2,4})\s+(.*)$/u;

const SKIP_SECTIONS = new Set([
  "contents",
  "legend",
  "server implementation",
  "client",
  "clients",
  "frameworks",
  "resources",
  "templates",
  "tools",
  "tips",
  "contributing",
]);

export interface ParsedEntry {
  name: string;
  url: string;
  description: string | null;
  category: string | null;
  language: string | null;
  official: boolean;
}

function stripMarkup(text: string): string {
  return text
    .replace(/<a\s+name="[^"]*"\s*>\s*<\/a>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}]/gu, "")
    .trim();
}

function detectLanguage(text: string): string | null {
  for (const [emoji, language] of LANGUAGE_EMOJI) {
    if (text.includes(emoji)) return language;
  }
  return null;
}

function detectOfficial(text: string): boolean {
  return OFFICIAL_MARKERS.some((marker) => text.includes(marker));
}

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

export function parseAwesomeReadme(markdown: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let category: string | null = null;
  let skip = false;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const depth = heading[1]?.length ?? 0;
      const text = stripMarkup(heading[2] ?? "");
      const key = text.toLowerCase();

      if (depth <= 2) {
        category = null;
        skip = SKIP_SECTIONS.has(key);
      } else if (!skip) {
        category = SKIP_SECTIONS.has(key) ? null : text || null;
      }
      continue;
    }

    if (skip) continue;

    const match = ENTRY_RE.exec(line);
    if (!match) continue;

    const label = (match[1] ?? "").trim();
    const url = (match[2] ?? "").trim();
    if (!label || !/^https?:\/\//i.test(url)) continue;

    // Everything after the primary link: badges, emoji markers, description.
    // Glama score badges are nested markdown links and must be removed first,
    // otherwise their alt text swallows the language markers.
    const rest = (match[3] ?? "").replace(INLINE_LINK_RE, " ");
    const separator = SEPARATOR_RE.exec(rest);
    const markers = separator ? rest.slice(0, separator.index) : rest;
    const description = separator
      ? rest.slice(separator.index).replace(SEPARATOR_RE, "").trim()
      : "";

    entries.push({
      name: label,
      url: normalizeUrl(url),
      description: description.length > 0 ? description : null,
      category,
      language: detectLanguage(markers),
      official: detectOfficial(markers),
    });
  }

  return entries;
}

/** GitHub repo metadata embedded in an entry is usually the install hint. */
export function repoFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return `https://github.com/${owner}/${repo.replace(/\.git$/, "")}`;
  } catch {
    return null;
  }
}

export function awesomeEntryToRaw(entry: ParsedEntry): RawServer {
  const repoUrl = repoFromUrl(entry.url);

  return {
    source: "awesome",
    id: repoUrl ? `github:${repoUrl.replace("https://github.com/", "").toLowerCase()}` : undefined,
    name: entry.name,
    description: entry.description,
    homepage: entry.url,
    repoUrl,
    isOfficial: entry.official,
    language: entry.language === "cloud" || entry.language === "local" ? null : entry.language,
    categories: entry.category ? [entry.category] : [],
    runtimes: entry.language === "local" ? ["local"] : entry.language === "cloud" ? ["cloud"] : [],
    raw: entry,
  };
}

export async function fetchAwesomeServers(url = DEFAULT_AWESOME_URL): Promise<RawServer[]> {
  const markdown = await fetchText(url, { headers: { "user-agent": USER_AGENT } });
  return parseAwesomeReadme(markdown).map(awesomeEntryToRaw);
}
