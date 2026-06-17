import type { Metadata } from "next";
import Providers from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "MarketPulse | Polymarket Intelligence",
  description: "Real-time Polymarket intelligence dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-pulse-bg antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
