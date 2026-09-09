import Fastify from 'fastify'
import { config } from './config.js'
import { registerRoutes } from './routes.js'
import { redis } from './redis.js'
import { startPoller, stopPoller } from './poller.js'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // Query strings are redacted wholesale. Ours are harmless, but this is the one
    // process that handles 511 keys and a logged key is a leaked key — cheaper to
    // never log the class of thing than to audit every log line.
    redact: ['req.query', 'req.headers.authorization'],
  },
  // Railway terminates TLS at its edge and forwards the real client address in
  // X-Forwarded-For. Without this, every request appears to come from the proxy.
  trustProxy: true,
})

await registerRoutes(app)

/**
 * Finish in-flight requests before exiting. Railway sends SIGTERM on every deploy,
 * and a hard exit would drop responses that had already spent a 511 request — the
 * one resource we cannot get back.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`)
    await stopPoller()
    await app.close()
    await redis.quit()
    process.exit(0)
  })
}

/** `::`, not `0.0.0.0` — and definitely not localhost. */
await app.listen({ port: config.port, host: '::' })

// The first thing worth seeing in a deploy log. Without it a healthy boot is silent,
// and a health-check failure gives you nothing to distinguish "crashed on startup"
// from "started fine, listening on the wrong interface".
app.log.info(`listening on :${config.port}`)

// Started after listen so a slow first sweep can't delay the health check, which
// Railway gates the deploy on.
startPoller()
