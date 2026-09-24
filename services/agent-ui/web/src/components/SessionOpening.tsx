export function SessionOpening() {
  return (
    <div className="session-opening" aria-busy="true">
      <p className="session-opening-status" role="status">
        Opening conversation history
      </p>
      <div className="session-opening-turns" aria-hidden="true">
        {[0, 1].map((turn) => (
          <div className="session-opening-turn" key={turn}>
            <span className="session-opening-line session-opening-short" />
            <span className="session-opening-line session-opening-question" />
            <span className="session-opening-line session-opening-short" />
            <span className="session-opening-line session-opening-process" />
            <span className="session-opening-line" />
            <span className="session-opening-line session-opening-answer" />
          </div>
        ))}
      </div>
    </div>
  );
}
