import { ErrorBoundary, type Component, type JSX } from "solid-js"

export const PanelErrorBoundary: Component<{
  content: () => JSX.Element
  onError: (error: unknown) => void
  fallback: (retry: () => void) => JSX.Element
}> = (props) => (
  <ErrorBoundary
    fallback={(error, reset) => {
      props.onError(error)
      return props.fallback(reset)
    }}
  >
    {props.content()}
  </ErrorBoundary>
)
