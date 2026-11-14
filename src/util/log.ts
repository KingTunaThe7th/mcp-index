/**
 * Minimal leveled logger.
 *
 * Untrusted text must never reach the terminal raw: `sanitizeForTerminal`
 * strips ANSI/OSC sequences so a catalog entry cannot rewrite your prompt or
 * set the clipboard via escape codes.
 */
import { sanitizeForTerminal } from "../security/sanitize.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let level: LogLevel = "info";
let jsonMode = false;
let stdioSafe = false;

export function setLogLevel(next: LogLevel): void {
  level = next;
}

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

/**
 * In stdio-gateway mode stdout *is* the MCP transport. A single log line there
 * corrupts the protocol stream, so everything is rerouted to stderr.
 */
export function setStdioSafe(enabled: boolean): void {
  stdioSafe = enabled;
}

function enabled(candidate: LogLevel): boolean {
  return ORDER[candidate] <= ORDER[level];
}

function write(stream: "stdout" | "stderr", prefix: string, message: string): void {
  const target = stdioSafe ? "stderr" : stream;
  // Multi-line output (tables, records) must keep its newlines, but escape
  // sequences are always stripped.
  const line = `${prefix}${sanitizeForTerminal(message, { multiline: true, maxLength: 0 })}`;
  if (target === "stdout") process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}

export const log = {
  error(message: string): void {
    if (enabled("error")) write("stderr", "error: ", message);
  },
  warn(message: string): void {
    if (enabled("warn")) write("stderr", "warn: ", message);
  },
  info(message: string): void {
    if (enabled("info")) write("stdout", "", message);
  },
  /** Human-facing output that must survive JSON mode (tables, results). */
  out(message: string): void {
    if (jsonMode) return;
    write("stdout", "", message);
  },
  debug(message: string): void {
    if (enabled("debug")) write("stderr", "debug: ", message);
  },
  isJson(): boolean {
    return jsonMode;
  },
};
