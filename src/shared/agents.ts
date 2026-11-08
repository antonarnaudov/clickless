// The agent clients Clickless knows by name: how they're shown (logo, label), how to recognise them
// from the name they connect with (MCP clientInfo, the CLI bridge, an HTTP User-Agent), and where
// their setup goes. Used by Settings → Agents & API and by agent profiles.

export type AgentClientId = 'claude-code' | 'codex' | 'gemini-cli' | 'cursor' | 'claude-desktop' | 'vscode' | 'windsurf' | 'cline' | 'clickless' | 'mcp' | 'http' | 'cli';

export interface AgentClientInfo {
  id: AgentClientId;
  name: string;
  /** Key in BRAND_ICONS, or a generic icon in the UI. */
  brand?: string;
  /** Matches the name the client connects with. */
  match: RegExp;
}

export const AGENT_CLIENTS: AgentClientInfo[] = [
  { id: 'claude-code', name: 'Claude Code', brand: 'claude-code', match: /claude[-_ ]?code/i },
  { id: 'codex', name: 'Codex', brand: 'codex', match: /codex/i },
  { id: 'gemini-cli', name: 'Gemini CLI', brand: 'gemini-cli', match: /gemini/i },
  { id: 'cursor', name: 'Cursor', brand: 'cursor', match: /cursor/i },
  { id: 'claude-desktop', name: 'Claude Desktop', brand: 'claude', match: /claude[-_ ]?(ai|desktop)|^claude$/i },
  { id: 'vscode', name: 'VS Code (Copilot)', brand: 'copilot', match: /visual studio code|vscode|copilot/i },
  { id: 'windsurf', name: 'Windsurf', brand: 'windsurf', match: /windsurf|codeium/i },
  { id: 'cline', name: 'Cline', brand: 'cline', match: /cline/i },
  { id: 'clickless', name: 'Clickless agent', match: /^clickless([-_ ]?(agent|panel|built-?in))?$/i },
  { id: 'cli', name: 'clickless CLI', match: /clickless[-_ ]?cli/i },
  { id: 'http', name: 'HTTP client', match: /curl|python|node-fetch|undici|axios|http|wget|n8n|postman/i },
  { id: 'mcp', name: 'MCP client', brand: 'mcp', match: /mcp/i },
];

/** Which known client a connection name belongs to (falls back to a generic MCP client). */
export function agentClient(name: string | undefined | null): AgentClientInfo {
  const n = String(name ?? '').trim();
  return AGENT_CLIENTS.find((c) => c.match.test(n)) ?? { ...AGENT_CLIENTS[AGENT_CLIENTS.length - 1], name: n || 'MCP client' };
}
