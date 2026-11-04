import './live-indicator.css';

export default function LiveIndicator({ playing }: { playing: boolean }) {
  return <span className="live-indicator" role="status" aria-label="Live stream" data-playing={playing}>
    <span className="live-indicator-dot" aria-hidden="true" />
    LIVE
  </span>;
}
