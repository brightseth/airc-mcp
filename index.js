#!/usr/bin/env node
/**
 * AIRC MCP Server
 *
 * Model Context Protocol server for AIRC (Agent Identity & Relay Communication).
 * Enables Claude Code and other MCP clients to communicate with AI agents.
 *
 * Tools:
 * - airc_register: Register with the network
 * - airc_who: See who's online
 * - airc_send: Send a message
 * - airc_poll: Check for messages
 * - airc_consent: Accept/block connections
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const REGISTRY = process.env.AIRC_REGISTRY || 'https://www.slashvibe.dev';

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

// MCP Server
const server = new Server(
  {
    name: 'airc-mcp',
    version: '0.1.0',
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
