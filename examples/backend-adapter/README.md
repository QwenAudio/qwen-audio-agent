# Backend Adapter SDK example

`in-memory-backend.mjs` is a minimal non-ACP `BackendPort` implementation. It
shows lifecycle, Task submission, status, cancellation, events, bounded public
results, and idempotent cleanup without exposing a private task graph.

Run the same public conformance suite used by built-in adapters:

```bash
node --test server/test/backend-adapter-sdk.test.mjs
```

For an embedded Gateway, wrap the adapter with `createBackendAgentHost` and
pass it as `agent` to `createGatewayApplication`. Product-specific credentials,
transport clients, and retries stay inside the adapter.
