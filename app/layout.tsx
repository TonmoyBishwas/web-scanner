import type { Metadata, Viewport } from "next";
import { Heebo, Roboto_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { EnvExposer } from "@/components/scanner/EnvExposer";
import { ThemeProvider } from "@/components/shared/ThemeProvider";

// Heebo — the terminal design's UI face (first-class Hebrew + Latin).
const appSans = Heebo({
  variable: "--font-app-sans",
  subsets: ["latin", "hebrew"],
  // 800/900 power the design's heavy titles / hero numerals.
  weight: ["400", "500", "700", "800", "900"],
  display: "swap",
});

// Roboto Mono — all numeric/technical values (weights, barcodes, LPNs);
// disambiguates 0/O, 1/l/I, 5/S.
const appMono = Roboto_Mono({
  variable: "--font-app-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

// Material Icons Round — the design's icon set, rendered via ligatures.
// Self-hosted (next/font/google excludes icon fonts); display:"block" hides
// raw ligature text ("check_circle") until the font loads.
const appIcons = localFont({
  src: "./fonts/material-icons-round.woff2",
  variable: "--font-app-icons",
  weight: "400",
  display: "block",
});

export const metadata: Metadata = {
  title: "Warehouse Barcode Scanner",
  description: "Web-based barcode scanner for warehouse inventory management",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Let content extend under the status bar / gesture pill so safe-area
  // insets can pad it back (preserves the zoom lock above).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${appSans.variable} ${appMono.variable} ${appIcons.variable} antialiased`}
      >
        <EnvExposer />
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
