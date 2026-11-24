/** zDeck's key-shaped z mark; follows the surrounding theme's ink color. */
export function BrandMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" role="img" aria-label="zDeck" focusable="false">
      <rect x="3.5" y="2.5" width="25" height="25" rx="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 29.5h20a5 5 0 0 0 5-5" stroke="currentColor" strokeOpacity=".4" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 10h12L10 20h12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
