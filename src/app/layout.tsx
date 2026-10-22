import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "BeMagic Pets · Um pequeno mundo, um grande amigo",
  description: "Adote um companheiro pixel, cuide dele e crie um mundo com as suas cores.",
  applicationName: "BeMagic Pets",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "BeMagic Pets" },
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
};

export const viewport: Viewport = { themeColor: "#34735a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR">
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
