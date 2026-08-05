export function createGracefulShutdown({
  app,
  cleanup,
  onError = () => {},
} = {}) {
  let closing = false
  let complete = false

  return event => {
    if (complete) return
    event?.preventDefault?.()
    if (closing) return
    closing = true
    Promise.resolve()
      .then(() => cleanup?.())
      .catch(error => onError(error))
      .finally(() => {
        complete = true
        app.quit()
      })
  }
}
