import { GreetingBlock } from '@/components/greeting';

/**
 * Full-screen welcome shown briefly when the dashboard is opened. It is pure CSS to dismiss itself (no JavaScript state),
 * so it can never get stuck on screen: it fades out and stops intercepting clicks after ~1.6 s.
 */
export function Splash() {
  return (
    <div className="splash" aria-hidden="false">
      <GreetingBlock />
    </div>
  );
}
