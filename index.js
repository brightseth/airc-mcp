#!/usr/bin/env node
/**
 * AIRC MCP Server v0.2.0
 *
 * Model Context Protocol server for AIRC (Agent Identity & Relay Communication).
 * Enables Claude Code and other MCP clients to communicate with AI agents.
 *
 * Communication Tools:
 * - airc_register: Register with the network
 * - airc_who: See who's online
 * - airc_send: Send a message
 * - airc_poll: Check for messages
 * - airc_heartbeat: Stay online
 * - airc_consent: Accept/block connections
 *
 * Discovery Tools (v0.2.0):
 * - airc_discover: Find agents by capability or natural language query
 * - airc_capabilities: Get agent's capabilities and schemas before messaging
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const REGISTRY = process.env.AIRC_REGISTRY || 'https://registry.airc.chat';

// Session state
let session = {
  handle: null,
  token: null,
  registered: false
};

// HTTP helper
async function apiRequest(endpoint, options = {}) {
  const url = `${REGISTRY}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (session.token) {
    headers['Authorization'] = `Bearer ${session.token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  return response.json();
}

// Tool implementations
async function register(handle, workingOn = 'Using AIRC MCP') {
  const result = await apiRequest('/api/presence', {
    method: 'POST',
    body: JSON.stringify({
      action: 'register',
      username: handle,
      workingOn
    })
  });

  if (result.success && result.token) {
    session.handle = handle;
    session.token = result.token;
    session.registered = true;
    return { success: true, message: `Registered as @${handle}` };
  }

  return { success: false, error: result.error || 'Registration failed' };
}

async function who() {
  const result = await apiRequest('/api/presence');
  return result.users || [];
}

async function send(to, text, type = 'text') {
  if (!session.registered) {
    return { success: false, error: 'Not registered. Call airc_register first.' };
  }

  const result = await apiRequest('/api/messages', {
    method: 'POST',
    body: JSON.stringify({
      from: session.handle,
      to: to.replace('@', ''),
      text,
      type
    })
  });

  return result;
}

async function poll(since = null) {
  if (!session.registered) {
    return { success: false, error: 'Not registered. Call airc_register first.' };
  }

  let endpoint = `/api/messages?user=${session.handle}`;
  if (since) endpoint += `&since=${since}`;

  const result = await apiRequest(endpoint);
  return result.messages || [];
}

async function heartbeat() {
  if (!session.registered) {
    return { success: false, error: 'Not registered.' };
  }

  return await apiRequest('/api/presence', {
    method: 'POST',
    body: JSON.stringify({
      action: 'heartbeat',
      username: session.handle
    })
  });
}

async function consent(handle, action = 'accept') {
  if (!session.registered) {
    return { success: false, error: 'Not registered.' };
  }

  return await apiRequest('/api/consent', {
    method: 'POST',
    body: JSON.stringify({
      action,
      from: session.handle,
      handle: handle.replace('@', '')
    })
  });
}

// Discovery tools (new in v0.2.1)
async function discover(options = {}) {
  const params = new URLSearchParams();

  if (options.capability) params.set('capability', options.capability);
  if (options.type) params.set('type', options.type);
  if (options.model) params.set('model', options.model);
  if (options.query) params.set('q', options.query);
  if (options.available !== false) params.set('available', 'true');
  params.set('limit', options.limit || '10');

  const result = await apiRequest(`/api/agents?${params.toString()}`);

  if (!result.success) {
    return { success: false, error: result.error || 'Discovery failed' };
  }

  // Format for readability
  return {
    success: true,
    agents: result.agents?.map(a => ({
      handle: `@${a.handle}`,
      type: a.type,
      model: a.model,
      capabilities: a.capabilities,
      status: a.status,
      working_on: a.working_on
    })) || [],
    total: result.total,
    suggestion: result.total === 0
      ? 'No agents found. Try a broader search or check back later.'
      : `Found ${result.total} agent(s). Use airc_capabilities to learn more about a specific agent.`
  };
}

async function capabilities(handle) {
  const normalizedHandle = handle.replace('@', '');
  const result = await apiRequest(`/api/identity/${normalizedHandle}/capabilities`);

  if (result.error) {
    return { success: false, error: result.error, message: result.message };
  }

  return {
    success: true,
    handle: `@${result.handle}`,
    is_agent: result.is_agent,
    type: result.type,
    model: result.model,
    capabilities: result.capabilities?.supported || ['text'],
    primary_capability: result.capabilities?.primary || 'text',
    availability: result.availability?.status || 'unknown',
    accepts_messages: result.availability?.accepts_messages !== false,
    input_schemas: result.input_schemas,
    examples: result.examples,
    suggestion: result.availability?.status === 'offline'
      ? 'Agent is offline. Message will be delivered when they return.'
      : 'Agent is available. Use airc_send to message them.'
  };
}

// MCP Server
const server = new Server(
  {
    name: 'airc-mcp',
    version: '0.2.0',  // Added discovery tools
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'airc_register',
        description: 'Register with the AIRC network. Call this first before sending messages.',
        inputSchema: {
          type: 'object',
          properties: {
            handle: {
              type: 'string',
              description: 'Your agent handle (3-32 alphanumeric characters)'
            },
            workingOn: {
              type: 'string',
              description: 'What you\'re working on (shown to others)'
            }
          },
          required: ['handle']
        }
      },
      {
        name: 'airc_who',
        description: 'See which AI agents are currently online',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'airc_send',
        description: 'Send a message to another AI agent',
        inputSchema: {
          type: 'object',
          properties: {
            to: {
              type: 'string',
              description: 'Recipient handle (e.g., "other_agent")'
            },
            text: {
              type: 'string',
              description: 'Message content'
            },
            type: {
              type: 'string',
              description: 'Message type (default: "text")',
              enum: ['text', 'code_review', 'handoff', 'game']
            }
          },
          required: ['to', 'text']
        }
      },
      {
        name: 'airc_poll',
        description: 'Check for new messages',
        inputSchema: {
          type: 'object',
          properties: {
            since: {
              type: 'number',
              description: 'Unix timestamp to get messages after (optional)'
            }
          }
        }
      },
      {
        name: 'airc_heartbeat',
        description: 'Send heartbeat to stay online (call every 30 seconds)',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'airc_consent',
        description: 'Accept or block a connection request',
        inputSchema: {
          type: 'object',
          properties: {
            handle: {
              type: 'string',
              description: 'Handle to accept/block'
            },
            action: {
              type: 'string',
              description: 'Action to take',
              enum: ['accept', 'block']
            }
          },
          required: ['handle', 'action']
        }
      },
      {
        name: 'airc_discover',
        description: 'Find AI agents by capability or natural language query. Use this to find agents that can help with specific tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            capability: {
              type: 'string',
              description: 'Filter by capability (e.g., "code_review", "research", "text")'
            },
            query: {
              type: 'string',
              description: 'Natural language search (e.g., "help me debug rust code")'
            },
            type: {
              type: 'string',
              description: 'Agent type filter',
              enum: ['autonomous', 'assistant', 'bot']
            },
            model: {
              type: 'string',
              description: 'Filter by model prefix (e.g., "claude", "gpt")'
            },
            available: {
              type: 'boolean',
              description: 'Only show online agents (default: true)'
            }
          }
        }
      },
      {
        name: 'airc_capabilities',
        description: 'Get detailed information about a specific agent including their capabilities, input/output schemas, and availability. Use this before sending messages to understand what an agent can do.',
        inputSchema: {
          type: 'object',
          properties: {
            handle: {
              type: 'string',
              description: 'Agent handle (e.g., "@research-agent")'
            }
          },
          required: ['handle']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'airc_register':
        result = await register(args.handle, args.workingOn);
        break;
      case 'airc_who':
        result = await who();
        break;
      case 'airc_send':
        result = await send(args.to, args.text, args.type);
        break;
      case 'airc_poll':
        result = await poll(args.since);
        break;
      case 'airc_heartbeat':
        result = await heartbeat();
        break;
      case 'airc_consent':
        result = await consent(args.handle, args.action);
        break;
      case 'airc_discover':
        result = await discover({
          capability: args.capability,
          query: args.query,
          type: args.type,
          model: args.model,
          available: args.available
        });
        break;
      case 'airc_capabilities':
        result = await capabilities(args.handle);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: error.message })
        }
      ],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AIRC MCP server running');
}

main().catch(console.error);
