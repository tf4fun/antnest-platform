export function SessionOpening({ error, onRetry, onBack }: {
  error?: string;
  onRetry?: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="session-opening" aria-busy={error === undefined}>
      {error === undefined ? <p className="session-opening-status" role="status">
        Opening conversation history
      </p> : <div className="session-opening-error">
        <p role="alert">{error}</p>
        <div className="session-opening-actions">
          <button type="button" onClick={onRetry}>Retry loading</button>
          <button type="button" onClick={onBack}>Back to agent</button>
        </div>
      </div>}
      {error === undefined ? <div className="session-opening-turns" aria-hidden="true">
        {[0, 1].map((turn) => (
          <div className="session-opening-turn" key={turn}>
            <span className="session-opening-line session-opening-short" />
            <span className="session-opening-line session-opening-question" />
            <span className="session-opening-line session-opening-short" />
            <span className="session-opening-process"><span className="session-opening-line session-opening-process-label" />
              <span className="session-opening-line session-opening-process-count" /></span>
            <span className="session-opening-line" />
            <span className="session-opening-line session-opening-answer" />
          </div>
        ))}
      </div> : null}
    </div>
  );
}
