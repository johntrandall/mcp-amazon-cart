import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { searchProducts, addToCart, removeFromCart, getCart } from './amazon';
import {
  searchProductsBusiness,
  addToCartBusiness,
  removeFromCartBusiness,
  getCartBusiness,
} from './amazon-business';
import { placeOrder } from './place-order';
import { closeBrowser, getContext, getPage } from './browser';
import { saveAmazonSession, restoreAmazonSession } from './session-manager';
import { dumpDom, inspectSelectors, findText } from './debug';
import {
  listReturnableItems,
  startReturn,
  getReturnStatus,
  finalizeReturn,
  listReturns,
  cancelReturn,
  RETURN_REASONS,
} from './returns';
import {
  checkLoginPersonal,
  checkLoginBusiness,
  refreshSessionPersonal,
  refreshSessionBusiness,
  sessionHealthPersonal,
  sessionHealthBusiness,
} from './session-health';

dotenv.config();

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

// Tool definitions (single source of truth)
const TOOLS = [
  // ---- Personal Amazon (amazon.com / AMAZON_DOMAIN) ----
  {
    name: 'search_amazon',
    description: 'Search for products on personal Amazon (www.amazon.com)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query for Amazon products' },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_to_cart',
    description: 'Add a product to the personal Amazon cart',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Product name to search and add' },
        asin: { type: 'string', description: 'Amazon ASIN (product ID) - use this if known' },
        quantity: { type: 'number', description: 'Quantity to add (default: 1)', default: 1 },
      },
    },
  },
  {
    name: 'view_cart',
    description: 'View current personal Amazon cart contents',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'remove_from_cart',
    description: 'Remove an item from the personal Amazon cart by ASIN',
    inputSchema: {
      type: 'object' as const,
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN currently in the cart' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'check_login',
    description:
      'Probe personal Amazon for session health. Navigates /your-orders, returns ' +
      'a typed CheckLoginResult with health (healthy / banner_blocked / auth_expired / ' +
      'mfa_challenge / mfa_push_pending / captcha_challenge / account_locked / ' +
      'unknown_degraded / refresh_in_progress), detected attention banners, and the ' +
      'reached URL. If a refresh is mid-flight, returns refresh_in_progress without ' +
      'navigating. Use session_health for the composite view that also includes ' +
      'last_refresh state and active returns count.',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // ---- Business Amazon (business.amazon.com) ----
  {
    name: 'search_amazon_business',
    description: 'Search for products on Amazon Business (business.amazon.com)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query for Amazon Business products' },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_to_cart_business',
    description: 'Add a product to the Amazon Business cart',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Product name to search and add' },
        asin: { type: 'string', description: 'Amazon ASIN (product ID) - use this if known' },
        quantity: { type: 'number', description: 'Quantity to add (default: 1)', default: 1 },
      },
    },
  },
  {
    name: 'view_cart_business',
    description: 'View current Amazon Business cart contents',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'remove_from_cart_business',
    description: 'Remove an item from the Amazon Business cart by ASIN',
    inputSchema: {
      type: 'object' as const,
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN currently in the Business cart' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'check_login_business',
    description:
      'Probe Amazon Business for session health. Navigates /ab/your-orders, returns ' +
      'a typed CheckLoginResult (see check_login). If a refresh is mid-flight, ' +
      'returns refresh_in_progress without navigating.',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // ---- Session-health (v1.1) ----
  {
    name: 'refresh_session_personal',
    description:
      'Programmatic re-auth for the personal Amazon session. Fetches credentials ' +
      'from 1Password at runtime (op CLI), drives the login wizard, handles TOTP ' +
      'MFA, and escalates to Pushover on operator-actionable failures (CAPTCHA, ' +
      'security challenges, wrong password, locked account). Returns a typed ' +
      'RefreshSessionResult — never throws. Pass force=true to refresh even when ' +
      'pre-flight health is already healthy. Refuses if a v1.0 returns task is in ' +
      'flight (returns_in_flight).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        force: {
          type: 'boolean',
          description: 'Skip the pre-flight health check and refresh unconditionally.',
        },
      },
    },
  },
  {
    name: 'refresh_session_business',
    description:
      'Programmatic re-auth for the Amazon Business session. Same semantics as ' +
      'refresh_session_personal, scoped to the business account.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        force: {
          type: 'boolean',
          description: 'Skip the pre-flight health check and refresh unconditionally.',
        },
      },
    },
  },
  {
    name: 'session_health_personal',
    description:
      'Composite session-health report for the personal account: current health, ' +
      'detected banners, last refresh outcome/error, container uptime, in-flight ' +
      'returns count, and whether a refresh is currently in flight. Read-only.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'session_health_business',
    description:
      'Composite session-health report for the business account: current health, ' +
      'detected banners, last refresh outcome/error, container uptime, in-flight ' +
      'returns count, and whether a refresh is currently in flight. Read-only.',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // ---- Order placement (both accounts) ----
  {
    name: 'place_order',
    description:
      'Place the current cart as an order. Enforces a hard subtotal cap (confirm_total_max_usd) server-side; operator approval is the caller\'s responsibility (autonomous-shopping skill). Returns order ID on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: {
          type: 'string',
          enum: ['personal', 'business'],
          description: 'Which Amazon account',
        },
        confirm_total_max_usd: {
          type: 'number',
          description: 'Hard cap — abort if cart total exceeds this',
        },
      },
      required: ['account', 'confirm_total_max_usd'],
    },
  },

  // ---- Session lifecycle ----
  {
    name: 'save_session',
    description:
      '(Optional) Manually trigger session save. Sessions are automatically saved periodically, after operations, and on shutdown, so this is typically not needed.',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // ---- Returns (both accounts) ----
  {
    name: 'list_returnable_items',
    description:
      'List items from recent orders. Returns items up to lookback_days regardless of return eligibility — past-window items appear with negative days_remaining, so callers can resolve an item the user mentions even when it can no longer be returned. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: {
          type: 'string',
          enum: ['personal', 'business'],
          description: 'Which Amazon account',
        },
        lookback_days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description: 'How far back to scan order history. Default 60; capped at 365 to bound scan latency.',
          default: 60,
        },
      },
      required: ['account'],
    },
  },
  {
    name: 'start_return',
    description:
      'Open the Amazon returns wizard for a specific item. Performs fail-fast eligibility checks (return window, non-returnable, account match, order ID format, auth, CAPTCHA) before any browser writes. On success returns a task_id, the agent-supplied reason echoed back (so caller can confirm before finalize), the offered refund methods, and whether replacement is also available (refund only for v1). Does NOT submit the return — call finalize_return for that.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: {
          type: 'string',
          enum: ['personal', 'business'],
          description: 'Which Amazon account',
        },
        order_id: {
          type: 'string',
          description: 'Amazon order ID, format ###-#######-#######. Whitespace is trimmed before validation.',
        },
        item_id: {
          type: 'string',
          description: 'ASIN of the item being returned. Resolve via list_returnable_items first.',
        },
        quantity: {
          type: 'integer',
          minimum: 1,
          description: 'Quantity to return. Omit to return the entire line item.',
        },
        reason: {
          type: 'string',
          enum: [...RETURN_REASONS],
          description: 'Agent-inferred Amazon return reason. Required. Echoed back in the response so the caller can confirm or override in finalize_return.',
        },
        reason_prose: {
          type: 'string',
          description: 'Optional: original user prose that drove the reason inference. Stored in the audit log.',
        },
      },
      required: ['account', 'order_id', 'item_id', 'reason'],
    },
  },
  {
    name: 'get_return_status',
    description:
      'Poll the current wizard step for a task_id. Use when start_return reported a slow step, or to confirm state before finalize_return. Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'task_id from start_return' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'finalize_return',
    description:
      'Submit the return for a task_id from start_return. Optionally override the echoed reason. Returns return_id and a host-side path to the printable QR code PNG. After this call the return is committed (cancelable via cancel_return only until carrier scan).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'task_id from start_return' },
        confirm_reason: {
          type: 'string',
          enum: [...RETURN_REASONS],
          description: 'Optional: override the reason picked at start_return.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_returns',
    description:
      'List returns for an account, optionally filtered by status. Read-only. Use for "did the refund post?" and "did Amazon receive it?" queries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: {
          type: 'string',
          enum: ['personal', 'business'],
          description: 'Which Amazon account',
        },
        status: {
          type: 'string',
          enum: ['open', 'completed', 'all'],
          description: 'Filter by return status. Default: all.',
          default: 'all',
        },
      },
      required: ['account'],
    },
  },
  {
    name: 'cancel_return',
    description:
      'Cancel a return that has not yet been physically dropped off (carrier-scanned). Returns success if cancelable, structured error if past scan or already refunded.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: {
          type: 'string',
          enum: ['personal', 'business'],
          description: 'Which Amazon account',
        },
        return_id: {
          type: 'string',
          description: 'return_id from finalize_return or list_returns',
        },
      },
      required: ['account', 'return_id'],
    },
  },

  // ---- Debug / selector discovery ----
  // These tools let an out-of-container caller (e.g. a Claude session) inspect
  // the live Amazon DOM in this container's Chrome without needing VNC.
  // Behind bearer auth; safe to leave deployed.
  {
    name: 'debug_dump_dom',
    description:
      'Dump the HTML of the current page (or a given URL) for selector-debt diagnosis. Returns up to maxBytes (default 200KB) of HTML.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Optional URL to navigate to first' },
        maxBytes: { type: 'number', description: 'Truncate HTML to this many bytes (default 200000)' },
      },
    },
  },
  {
    name: 'debug_inspect_selectors',
    description:
      'Test a list of CSS selectors against the current page and report match count, first element text/id/class/href for each.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Optional URL to navigate to first' },
        selectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'CSS selectors to inspect',
        },
      },
      required: ['selectors'],
    },
  },
  {
    name: 'debug_find_text',
    description:
      'Search the entire DOM for elements whose text matches a regex. Returns up to 20 matches with DOM path, id, class, outer HTML.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Optional URL to navigate to first' },
        pattern: { type: 'string', description: 'JavaScript regex pattern (without delimiters)' },
        flags: { type: 'string', description: 'Regex flags (default "i")' },
      },
      required: ['pattern'],
    },
  },
];

// Create a new MCP server instance with handlers
function createMcpServer(): Server {
  const server = new Server(
    { name: 'amazon-cart-server', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result;

      switch (name) {
        // Personal
        case 'search_amazon':
          result = await searchProducts((args as any)?.query);
          break;
        case 'add_to_cart':
          result = await addToCart(args as any);
          break;
        case 'view_cart':
          result = await getCart();
          break;
        case 'remove_from_cart':
          result = await removeFromCart(args as any);
          break;
        case 'check_login':
          result = await checkLoginPersonal();
          break;

        // Business
        case 'search_amazon_business':
          result = await searchProductsBusiness((args as any)?.query);
          break;
        case 'add_to_cart_business':
          result = await addToCartBusiness(args as any);
          break;
        case 'view_cart_business':
          result = await getCartBusiness();
          break;
        case 'remove_from_cart_business':
          result = await removeFromCartBusiness(args as any);
          break;
        case 'check_login_business':
          result = await checkLoginBusiness();
          break;

        // ---- Session-health (v1.1) ----
        case 'refresh_session_personal':
          result = await refreshSessionPersonal(args as any);
          break;
        case 'refresh_session_business':
          result = await refreshSessionBusiness(args as any);
          break;
        case 'session_health_personal':
          result = await sessionHealthPersonal();
          break;
        case 'session_health_business':
          result = await sessionHealthBusiness();
          break;

        // Order placement
        case 'place_order':
          result = await placeOrder(args as any);
          break;

        // Session
        case 'save_session': {
          const context = await getContext();
          await saveAmazonSession(context);
          result = {
            success: true,
            message:
              'Amazon session saved successfully. Your login will persist across server restarts.',
          };
          break;
        }

        // Returns (both accounts)
        case 'list_returnable_items':
          result = await listReturnableItems(args as any);
          break;
        case 'start_return':
          result = await startReturn(args as any);
          break;
        case 'get_return_status':
          result = await getReturnStatus(args as any);
          break;
        case 'finalize_return':
          result = await finalizeReturn(args as any);
          break;
        case 'list_returns':
          result = await listReturns(args as any);
          break;
        case 'cancel_return':
          result = await cancelReturn(args as any);
          break;

        // Debug / selector discovery
        case 'debug_dump_dom':
          result = await dumpDom(args as any);
          break;
        case 'debug_inspect_selectors':
          result = await inspectSelectors(args as any);
          break;
        case 'debug_find_text':
          result = await findText(args as any);
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Create Express server
const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.disable('etag');
app.disable('x-powered-by');

// Authentication middleware
const authenticate = (req: Request, res: Response, next: express.NextFunction) => {
  const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const queryToken = req.query.token as string;
  const providedToken = headerToken || queryToken;

  if (!AUTH_TOKEN) {
    next();
    return;
  }

  if (providedToken === AUTH_TOKEN) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'amazon-mcp-server' });
});

// Track transports per session
const transports = new Map<string, StreamableHTTPServerTransport>();

// Streamable HTTP endpoint
app.all('/mcp', authenticate, express.json(), async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (req.method === 'POST') {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId) {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session not found. The client must start a new session.' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);

    // Store transport after handleRequest so sessionId is available
    if (transport.sessionId && !transports.has(transport.sessionId)) {
      transports.set(transport.sessionId, transport);
    }
  } else if (req.method === 'GET') {
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing or invalid session ID for GET SSE stream.' },
        id: null,
      });
    }
  } else if (req.method === 'DELETE') {
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.close();
      transports.delete(sessionId);
      res.status(200).end();
    } else {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session not found.' },
        id: null,
      });
    }
  } else {
    res.status(405).end();
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Amazon MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);

  console.log('\nInitializing browser...');
  try {
    const context = await getContext();
    const page = await getPage();
    const AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || 'amazon.com';

    const restored = await restoreAmazonSession(context);
    await page.goto(`https://www.${AMAZON_DOMAIN}`, { waitUntil: 'domcontentloaded' });

    if (restored) {
      console.log('✓ Browser opened with restored session!');
    } else {
      console.log('✓ Browser opened! Please log into Amazon if needed.');
    }
    console.log('✓ Your session will be automatically saved.\n');

    setInterval(async () => {
      try {
        const currentContext = await getContext();
        await saveAmazonSession(currentContext);
        console.log('✓ Session auto-saved');
      } catch (error) {
        console.error('Failed to auto-save session:', error);
      }
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error('✗ Failed to initialize browser:', error);
  }
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\nShutting down...');

  try {
    const context = await getContext();
    await saveAmazonSession(context);
    console.log('✓ Session saved before shutdown');
  } catch (error) {
    console.error('Failed to save session before shutdown:', error);
  }

  for (const transport of transports.values()) {
    await transport.close();
  }
  transports.clear();

  await closeBrowser();
  process.exit(0);
});
