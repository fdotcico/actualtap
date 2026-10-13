const fastify = require("fastify")({
  bodyLimit: 16384,
  disableRequestLogging: true,
  logger: {
    redact: ['req.headers', 'request.headers', 'req.body', 'request.body'],
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
        ignore: "hostname,pid",
        singleLine: false,
        hideObject: false,
      },
    },
  },
  ajv: {
    customOptions: {
      allowUnionTypes: true,
    },
  },
  routerOptions: {
    ignoreTrailingSlash: true,
  },
  pluginTimeout: 120000, // 120 seconds to match Actual API initialization timeout and retries
});
const { version } = require("../package.json");

// Modular function registrations
async function registerModules() {
  await fastify.register(require("./plugins/env"));

  await fastify.register(require('./plugins/auth'));
  await fastify.register(require('./plugins/outbox'));

  await fastify.register(require("@fastify/cors"), {
    methods: ["GET", "POST"],
  });
  await fastify.register(require("./plugins/actualConnector"));
  await fastify.register(require("./plugins/delivery"));
  await fastify.register(require("./routes/transaction"));
  await fastify.register(require("./routes/health"));
}

// Global Error Handler
fastify.setErrorHandler((error, request, reply) => {
  const status = error.statusCode || 500;
  fastify.log.error({ requestId: reply.request.id, statusCode: status }, 'Request failed');
  reply.status(status).send({ error: status < 500 ? 'Invalid request' : 'Internal server error' });
});

// Start the server
const start = async () => {
  try {
    fastify.log.info(`Starting ActualTap v${version}`);
    await registerModules();
    try {
      // Try IPv6 dual-stack first
      await fastify.listen({ port: 3001, host: "::" });
    } catch (err) {
      if (err.code === 'EAFNOSUPPORT' || err.message.includes('address family not supported')) {
        fastify.log.warn('IPv6 not supported, falling back to IPv4');
        await fastify.listen({ port: 3001, host: "0.0.0.0" });
      } else {
        throw err;
      }
    }
  } catch (err) {
    fastify.log.error({ errorType: err.name }, "Startup failed; check configuration, storage, authentication and connectivity");
    await fastify.close().catch(() => {});
    process.exit(1);
  }
};

process.once('SIGTERM', () => { void fastify.close().catch(() => { process.exitCode = 1; }); });
process.once('SIGINT', () => { void fastify.close().catch(() => { process.exitCode = 1; }); });
start();