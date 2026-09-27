import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "./sw-register";

export const metadata: Metadata = {
  title: {
    default: "Friction Vault",
    template: "%s · Friction Vault",
  },
  description:
    "A private, local delay between an impulse and your Screen Time PIN.",
  applicationName: "Friction Vault",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Friction Vault",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light",
  themeColor: "#193b2d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="./manifest.webmanifest" />
        <link rel="icon" href="./favicon.png" sizes="64x64" />
        <link rel="apple-touch-icon" href="./apple-touch-icon.png" />
        <meta property="og:title" content="Friction Vault" />
        <meta
          property="og:description"
          content="Pause the impulse. Keep the choice."
        />
        <meta property="og:image" content="./og.png" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
