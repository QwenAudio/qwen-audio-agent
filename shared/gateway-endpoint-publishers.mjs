import {
  defineGatewayEndpointPublisher,
  parseGatewayEndpointDescriptor,
} from './gateway-remote-access.mjs'

function endpointFor(publisher, url) {
  return parseGatewayEndpointDescriptor({
    url,
    secure: String(url).startsWith('https://'),
    publisher,
  })
}

export function createLocalGatewayEndpointPublisher({
  url = 'http://127.0.0.1:3101',
} = {}) {
  const endpoint = endpointFor('local', url)
  return defineGatewayEndpointPublisher({
    id: 'local',
    inspect: async () => ({ available: true, published: true, endpoint }),
    publish: async () => endpoint,
    unpublish: async () => ({ published: true, endpoint }),
  })
}

export function createManualGatewayEndpointPublisher({ url } = {}) {
  const endpoint = endpointFor('manual', url)
  return defineGatewayEndpointPublisher({
    id: 'manual',
    inspect: async () => ({ available: true, published: true, endpoint }),
    publish: async () => endpoint,
    unpublish: async () => ({ published: true, endpoint }),
  })
}

export function createGatewayEndpointPublisherRegistry(publishers = []) {
  const entries = new Map()
  const register = publisher => {
    const defined = defineGatewayEndpointPublisher(publisher)
    if (entries.has(defined.id)) {
      throw new Error(`Duplicate Gateway endpoint publisher: ${defined.id}`)
    }
    entries.set(defined.id, defined)
    return defined
  }
  for (const publisher of publishers) register(publisher)

  const requirePublisher = id => {
    const publisher = entries.get(id)
    if (!publisher) {
      const error = new Error(`Unknown Gateway endpoint publisher: ${id}`)
      error.code = 'gateway_endpoint_publisher_unknown'
      throw error
    }
    return publisher
  }
  return Object.freeze({
    register,
    list: () => [...entries.values()],
    get: id => entries.get(id) || null,
    inspect: id => requirePublisher(id).inspect(),
    publish: async id => {
      const endpoint = parseGatewayEndpointDescriptor(
        await requirePublisher(id).publish(),
      )
      if (endpoint.publisher !== id) {
        throw new Error(`Gateway endpoint publisher ${id} returned ${endpoint.publisher}`)
      }
      return endpoint
    },
    unpublish: id => requirePublisher(id).unpublish(),
  })
}
