/**
 * Local entry point. Judges connect over HTTP; this exists so the same tools
 * can be driven from a desktop MCP client during development.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './server.js';

const server = createMcpServer(loadConfig());
await server.connect(new StdioServerTransport());
