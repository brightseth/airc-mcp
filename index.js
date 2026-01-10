#!/usr/bin/env node
/**
 * AIRC MCP Server v0.2.0
 *
 * Model Context Protocol server for AIRC (Agent Identity & Relay Communication).
 * Enables Claude Code and other MCP clients to communicate with AI agents.
 *
 * Tools:
 * - airc_register: Register with the network (supports recovery keys)
 * - airc_who: See who's online
 * - airc_send: Send a message
 * - airc_poll: Check for messages
 * - airc_consent: Accept/block connections
 * - airc_rotate_key: Rotate signing key (AIRC v0.2)
 * - airc_revoke: Permanently revoke identity (AIRC v0.2)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  getOrCreateKeypair,
  createSignedMessage,
  getOrCreateRecoveryKeypair,
  generateKeypair,
  saveKeypair,
  generateRotationProof,
  generateRevocationProof
} from './crypto.js';

const REGISTRY = process.env.AIRC_REGISTRY || 'https://www.slashvibe.dev';

// Signing mode: 'none' | 'optional' | 'required'
// Default to 'optional' for gradual security adoption
const SIGNING_MODE = process.env.AIRC_SIGNING_MODE || 'optional';

// Session state
let session = {
  handle: null,
  token: null,
  registered: false,
  keypair: null,
  recoveryKeypair: null,  // AIRC v0.2
  signingEnabled: false
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
async function register(handle, workingOn = 'Using AIRC MCP', withRecoveryKey = false) {
  // Initialize keys if signing is enabled
  if (SIGNING_MODE !== 'none') {
    try {
      session.keypair = await getOrCreateKeypair(handle);
      session.signingEnabled = true;
    } catch (error) {
      if (SIGNING_MODE === 'required') {
        return {
          success: false,
          error: `Signing is required but key generation failed: ${error.message}`
        };
      }
      // In optional mode, continue without signing
      session.signingEnabled = false;
    }
  }

  // Generate recovery key if requested (AIRC v0.2)
  if (withRecoveryKey) {
    try {
      session.recoveryKeypair = await getOrCreateRecoveryKeypair(handle);
    } catch (error) {
      return {
        success: false,
        error: `Recovery key generation failed: ${error.message}`
      };
    }
  }

  const body = {
    action: 'register',
    username: handle,
    building: workingOn  // Changed from workingOn for /api/users
  };

  // Include public key if available
  if (session.keypair) {
    body.publicKey = `ed25519:${session.keypair.publicKey}`;
  }

  // Include recovery key if available (AIRC v0.2)
  if (session.recoveryKeypair) {
    body.recoveryKey = `ed25519:${session.recoveryKeypair.publicKey}`;
  }

  // Use /api/users endpoint (supports recovery keys)
  const result = await apiRequest('/api/users', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (result.success && result.token) {
    session.handle = handle;
    session.token = result.token;
    session.registered = true;

    const signingStatus = session.signingEnabled ? ' (signing enabled)' : ' (Safe Mode)';
    const recoveryStatus = session.recoveryKeypair ? ' + recovery key' : '';
    return {
      success: true,
      message: `Registered as @${handle}${signingStatus}${recoveryStatus}`
    };
  }

  return { success: false, error: result.error || 'Registration failed' };
}

async function who() {
  const result = await apiRequest('/api/presence');
  return result.users || [];
}

async function send(to, text, type = 'text', payload = null) {
  if (!session.registered) {
    return { success: false, error: 'Not registered. Call airc_register first.' };
  }

  const recipient = to.replace('@', '');
  let messageBody;

  // Sign if we have keys and signing is not disabled
  if (session.keypair && SIGNING_MODE !== 'none') {
    messageBody = createSignedMessage(
      {
        from: session.handle,
        to: recipient,
        text,
        type,
        payload
      },
      session.keypair.privateKey
    );
  } else {
    // Unsigned message (Safe Mode)
    if (SIGNING_MODE === 'required') {
      return {
        success: false,
        error: 'Signing is required but no keys available'
      };
    }

    messageBody = {
      from: session.handle,
      to: recipient,
      text,
      type
    };

    if (payload) {
      messageBody.payload = payload;
    }
  }

  const result = await apiRequest('/api/messages', {
    method: 'POST',
    body: JSON.stringify(messageBody)
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

// ============ AIRC v0.2: Key Rotation & Revocation ============

async function rotateKey() {
  if (!session.registered) {
    return { success: false, error: 'Not registered. Call airc_register first.' };
  }

  // Load recovery key if not already loaded
  if (!session.recoveryKeypair) {
    session.recoveryKeypair = await getOrCreateRecoveryKeypair(session.handle);
  }

  if (!session.recoveryKeypair) {
    return {
      success: false,
      error: 'Recovery key required for rotation. Re-register with withRecoveryKey: true'
    };
  }

  // Generate new keypair
  const newKeypair = generateKeypair();
  const newPublicKey = `ed25519:${newKeypair.publicKey}`;

  // Generate rotation proof
  const proof = generateRotationProof(newPublicKey, session.recoveryKeypair.privateKey);

  // Send rotation request
  const result = await apiRequest(`/api/identity/${session.handle}/rotate`, {
    method: 'POST',
    body: JSON.stringify({
      new_public_key: newPublicKey,
      proof
    })
  });

  // Update session if rotation succeeded
  if (result.success && result.token) {
    session.keypair = newKeypair;
    session.token = result.token;
    await saveKeypair(session.handle, newKeypair);

    return {
      success: true,
      message: `Key rotated for @${session.handle}`,
      new_token: result.token,
      key_rotated_at: result.key_rotated_at
    };
  }

  return { success: false, error: result.error || 'Rotation failed' };
}

async function revokeIdentity(reason) {
  if (!session.registered) {
    return { success: false, error: 'Not registered. Call airc_register first.' };
  }

  // Load recovery key if not already loaded
  if (!session.recoveryKeypair) {
    session.recoveryKeypair = await getOrCreateRecoveryKeypair(session.handle);
  }

  if (!session.recoveryKeypair) {
    return {
      success: false,
      error: 'Recovery key required for revocation'
    };
  }

  // Generate revocation proof
  const proof = generateRevocationProof(session.handle, reason, session.recoveryKeypair.privateKey);

  // Send revocation request
  const result = await apiRequest('/api/identity/revoke', {
    method: 'POST',
    body: JSON.stringify(proof)
  });

  // Clear session if revocation succeeded
  if (result.success) {
    session.token = null;
    session.registered = false;

    return {
      success: true,
      message: `Identity @${session.handle} has been revoked. This action cannot be undone.`
    };
  }

  return { success: false, error: result.error || 'Revocation failed' };
}

// MCP Server
const server = new Server(
  {
    name: 'airc-mcp',
    version: '0.2.0',
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
            },
            withRecoveryKey: {
              type: 'boolean',
              description: 'Generate recovery key for key rotation (AIRC v0.2, default: false)'
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
        description: 'Send a message to another AI agent. Messages are signed with Ed25519 when enabled.',
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
            },
            payload: {
              type: 'object',
              description: 'Optional structured payload (JSON)'
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
        name: 'airc_rotate_key',
        description: 'Rotate signing key using recovery key (AIRC v0.2). Generates new signing key and invalidates old sessions.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'airc_revoke',
        description: 'Permanently revoke identity (AIRC v0.2). WARNING: This action cannot be undone. Use only for compromised accounts.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Revocation reason (e.g., "compromised_device", "lost_recovery_key")',
              enum: ['compromised_device', 'lost_device', 'security_precaution', 'account_migration', 'other']
            }
          },
          required: ['reason']
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
        result = await register(args.handle, args.workingOn, args.withRecoveryKey);
        break;
      case 'airc_who':
        result = await who();
        break;
      case 'airc_send':
        result = await send(args.to, args.text, args.type, args.payload);
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
      case 'airc_rotate_key':
        result = await rotateKey();
        break;
      case 'airc_revoke':
        result = await revokeIdentity(args.reason);
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
