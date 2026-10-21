import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UI_MIME_TYPE, VIEW_URIS, viewHtml, type ViewName } from './views.js';

const TITLES: Record<ViewName, string> = {
  rates: 'Rates and conversions',
  corridor: 'One pair across central banks',
  watchlist: 'Watchlist',
};

/**
 * Serve each MCP Apps view as a `ui://` resource. Hosts that support the
 * extension fetch it when a tool whose `_meta.ui.resourceUri` points here is
 * called; hosts that do not never ask, and get the tool's text as before.
 * The views make no network requests of their own, so they declare no CSP
 * domains and run under the host's most restrictive default.
 */
export function registerUiResources(server: McpServer): void {
  for (const view of Object.keys(VIEW_URIS) as ViewName[]) {
    const uri = VIEW_URIS[view];
    const html = viewHtml(view);
    server.registerResource(
      `view-${view}`,
      uri,
      { title: TITLES[view], description: `MCP Apps view: ${TITLES[view].toLowerCase()}`, mimeType: UI_MIME_TYPE },
      async () => ({
        contents: [{ uri, mimeType: UI_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: false } } }],
      }),
    );
  }
}

/** `_meta` for a tool whose results render in `view`. */
export function uiMeta(view: ViewName): { ui: { resourceUri: string } } {
  return { ui: { resourceUri: VIEW_URIS[view] } };
}
