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
import { searchProducts, addToCart, getCart, checkLoginStatus } from './amazon';
import {
  searchProductsBusiness,
  addToCartBusiness,
  getCartBusiness,
  checkLoginStatusBusiness,
} from './amazon-business';
import { placeOrder } from './place-order';
import { closeBrowser, getContext, getPage } from './browser';
import { saveAmazonSession, restoreAmazonSession } from './session-manager';

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
    name: 'check_login',
    description: 'Check if logged into personal Amazon',
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
    name: 'check_login_business',
    description: 'Check if logged into Amazon Business',
    inputSchema: { type: 'object' as const, properties: {} },
  },

  // ---- Order placement (both accounts) ----
  {
    name: 'place_order',
    description:
      'Place the current cart as an order. REQUIRES Pushover ACK from the user before finalizing. Returns order ID on success.',
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
        case 'check_login':
          result = await checkLoginStatus();
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
        case 'check_login_business':
          result = await checkLoginStatusBusiness();
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
    await page.goto(`https://www.${AMAZON_DOMAIN}`, { waitUntil: 'networkidle' });

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
