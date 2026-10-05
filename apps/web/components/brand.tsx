/** The product wordmark: "DEOD" in white and "Scan" in the logo gradient, set in the brand display font. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-brand font-bold tracking-tight ${className}`}>
      DEOD<span className="brand-grad">Scan</span>
    </span>
  );
}
