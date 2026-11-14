/**
 * Minimal MCP server used by the gateway integration test.
 *
 * It deliberately reports the environment it inherited so the test can assert
 * that the sandbox dropped a secret and replaced `$HOME`. The tool description
 * contains an ANSI escape to prove descriptions are sanitized on the way out.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-fixture", version: "1.2.3" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo text back.\u001b[31m SHOULD-NOT-SURVIVE\u001b[0m",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "write_thing",
      description: "Pretend to write a file (destructive).",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = String(request.params.arguments?.text ?? "");
  const secret = process.env.MCP_INDEX_TEST_SECRET ? "LEAKED" : "clean";
  return {
    content: [
      {
        type: "text",
        text: `echo:${text}|env:${secret}|home:${process.env.HOME ?? ""}|cwd:${process.cwd()}`,
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
