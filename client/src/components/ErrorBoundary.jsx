import React from 'react';

/**
 * Catches render-time errors anywhere below it.
 *
 * Without this, a single thrown error (an undefined component, an unexpected
 * API shape) unmounts the whole React tree and the user gets a blank white
 * page with no clue what happened. This turns that into a readable message
 * plus a way back.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the real stack in the console for debugging.
    console.error('[ui] render error:', error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
    if (this.props.onReset) this.props.onReset();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="page">
        <div className="callout callout-error" role="alert">
          <strong>Something went wrong displaying this page.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error.message || String(error)}
          </div>
        </div>
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={this.handleReset}>
            Try again
          </button>
          <button className="btn btn-ghost" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
