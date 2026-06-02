import type { Metadata } from "next";
import "./globals.css";
import AuthProvider from "@/components/AuthProvider";

export const metadata: Metadata = {
    title: "Cruzonic Dialer | Sales Power Dialer",
    description: "Custom outbound sales dialer powered by Twilio. Make calls, manage leads, and close deals faster.",
};

// Inline script — runs before paint to prevent a flash of the wrong theme.
// We can't read localStorage on the server, so we set the data-theme attribute
// from localStorage as the very first thing on the client.
const themeBootstrap = `
(function() {
  try {
    var t = localStorage.getItem('cruzonic_theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* ignore */ }
})();
`;

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
            </head>
            <body>
                <AuthProvider>{children}</AuthProvider>
            </body>
        </html>
    );
}
