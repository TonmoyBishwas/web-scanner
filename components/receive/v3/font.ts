/**
 * Receive form v3: Rubik, the design's one font (400/500/600/700, Hebrew +
 * Latin). Exposed as `--font-v3` and applied ONLY on the v3 root element, so
 * Heebo stays the app's font everywhere else.
 */
import { Rubik } from 'next/font/google';

export const rubik = Rubik({
  weight: ['400', '500', '600', '700'],
  subsets: ['hebrew', 'latin'],
  display: 'swap',
  variable: '--font-v3',
});
