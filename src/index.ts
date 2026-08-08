import { loadConfig } from './config.js'
import { createProvider } from './provider.js'
import { createGatewayServer } from './server.js'

const config = loadConfig()
const server = createGatewayServer(config, createProvider(config))

server.listen(config.port, config.host, () => {
  process.stdout.write(`BongoStock gateway listening on http://${config.host}:${config.port}\n`)
})

function shutdown(signal: string) {
  process.stdout.write(`${signal}: shutting down\n`)
  server.close(error => {
    if (error) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    }
  })
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
