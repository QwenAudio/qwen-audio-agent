import { createFrontendRuntime } from '../../src/app/frontend-runtime.mjs'
import { attachGatewayClientTransport } from '../../src/transport/gateway-client-transport.mjs'

// Same production factory and transport as the application composition root.
// Test overrides replace external services, never the session implementation.
export function attachTestGateway(server, options) {
  const frontendRuntime = createFrontendRuntime(options)
  const transport = attachGatewayClientTransport(server, { ...options, frontendRuntime })
  return {
    ...transport,
    async close() {
      await transport.close()
      await frontendRuntime.close()
    },
  }
}
