import type { Metadata, Viewport } from "next";
import { Rubik, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { EnvExposer } from "@/components/scanner/EnvExposer";
import { ThemeProvider } from "@/components/shared/ThemeProvider";

// Rubik — first-class Hebrew + Latin in one voice, tall x-height + softly
// rounded terminals read clearly at a glance for low-literacy warehouse
// workers. (subsets:["hebrew"] ships the Hebrew glyphs Geist lacked.)
const appSans = Rubik({
  variable: "--font-app-sans",
  subsets: ["latin", "hebrew"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// IBM Plex Mono — disambiguates 0/O, 1/l/I, 5/S for barcodes, SKUs, LPNs.
const appMono = IBM_Plex_Mono({
  variable: "--font-app-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
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
    <html lang="en" className="light">
      <body
        className={`${appSans.variable} ${appMono.variable} antialiased`}
      >
        <EnvExposer />
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
