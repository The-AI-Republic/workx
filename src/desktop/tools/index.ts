/**
 * Desktop Tools Module
 *
 * Browser automation runs through the MCPManager builtin 'browser' server
 * (chrome-devtools-mcp sidecar) after the Track 43 cutover — there is no
 * longer a separate "native CDP" path in the WebView. The terminal tool
 * lives in `./terminal` (used by the runtime sidecar).
 *
 * @module desktop/tools
 */

export { TerminalTool, SecurityFilter } from './terminal';
